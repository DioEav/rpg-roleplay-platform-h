/* useImageGeneration — AI 生图「提交 + 每 2s 轮询到 done/failed + 凭据错误分类」内核收口。
 *
 * 此前 components/GenerateImageModal.jsx(GEN 弹窗)与 components/MediaStudio.jsx(GEN tab)
 * 各自手抄一份 images.generate → 每 2s images.get 轮询 → done/failed → isCredentialsError 分类。
 * 本 hook 把这个内核提炼成单一实现 —— 行为零变化:两组件各自的 UI/tab 结构、文案、busy 表示
 * (布尔 vs 'generating')、response 预检差异(MediaStudio 额外查 quota/响应级 creds)、轮询 catch
 * 间隔(2000 vs 2500)全部用参数/回调逐字保留。
 *
 *   useImageGeneration({ onDone, onFail }) → { generate, generating, error, credsMissing, reset, stop }
 *
 *   · generate(body, perCall):
 *       body    = { prompt, kind, api_id, model, attach, size, save_id, ... }(由调用方按各自语义组装)。
 *       perCall = {
 *         inspect(r)        在拿到 generate() 响应后、判定 image_id 前调用;返回 truthy 表示「已处理,
 *                           别再继续」(MediaStudio 用它查响应级 credentials/quota)。可选。
 *         doneFromStatus(r) 从轮询响应推 status(默认 r.status;MediaStudio 传 r.status||(r.ok&&'done'))。
 *         failFallback      failed 时取错文的兜底('生成失败' / 'generation_error')。
 *         noImageIdMsg      响应无 image_id 时的错误文('服务端未返回任务 ID');不传则用 r.error。
 *         pollCatchMs       轮询 catch 后重试间隔(默认 2000;MediaStudio 传 2500)。
 *         emptyResStops     轮询返回空响应时:true→停并报错(GenerateImageModal),false→继续轮询(MediaStudio)。
 *         maxPollAttempts   轮询次数上限(默认 POLL_MAX_ATTEMPTS);超限报错收尾。
 *         pollTimeoutMsg    超限时的错误文。
 *       }
 *   · generating  布尔(调用方各自映射到自己的 busy 表示)。
 *   · error / credsMissing  分类后的错误态(isCredentialsError → credsMissing)。
 *   · onDone(url, imageId)  done 时回调(成功 url + 该图在 ai_images 里的 id)。onFail(msg,{creds})
 *                  可选,失败时回调(承接 MediaStudio 把生图失败路由进它与上传/图库共用的 fail())。
 *
 * 轮询固定 2s(setTimeout 链),终态 = done(需 url,若 requireUrl)/ failed / **cancelled**,
 * 并受 maxPollAttempts 硬上限约束;凭据分类统一走 lib/creds.isCredentialsError(对字符串即
 * /credentials_required|needs_credentials/i,与两宿主原逻辑等价)。
 * stop() 会作废在途请求(取消纪元),所以关弹窗/卸载之后不会再有一条自己复活的轮询链。
 * 成功时**就地广播** `rpg-image-updated`(op=ready,与后端 SSE 同形状):生图跑在独立进程里,
 * 它的 SSE 事件跨进程投递需要 Redis,没配时聊天里的图要刷新才出现 —— 这一枪让当前浏览器实时追加。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { isCredentialsError } from '../lib/creds.js';

// 轮询硬上限:2s × 150 ≈ 5 分钟,超过就报错收尾。生图正常在数十秒内完成,所以走到上限
// 只可能是「后端记录永远到不了终态」(worker 被 kill、服务重启后任务耗尽重试,ai_images
// 那行没人回收 —— 后端侧有 _reap_stuck_images 兜底,这里是客户端侧的兜底)。
// 没有它时,MediaStudio 的 emptyResStops/catchStops 都是 false ⇒ 本就无终止条件,
// 加上 requireUrl:true 遇到 done-但-url 为空的记录也会一直转。
const POLL_MAX_ATTEMPTS = 150;

export function useImageGeneration({ onDone, onFail } = {}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [credsMissing, setCredsMissing] = useState(false);
  const pollRef = useRef(null);
  // 本次生成的 kind(供成功时本地广播事件带上,消费方用它当 tooltip/分类)。
  const kindRef = useRef('');
  // 陈旧取消守卫:每次 generate() 递增,poll 在每个 await 后校验是否仍为当前轮次。
  const genIdRef = useRef(0);
  // 取消纪元:stop() 递增。只靠 genIdRef 挡不住**在途**请求 —— 见 stop() 的注释。
  const cancelRef = useRef(0);

  const stop = useCallback(() => {
    // 推进取消纪元,让已经飞出去、还没回来的请求作废。
    // 只 clearTimeout 是不够的:poll 在 await 之后会**重新挂上**一个新的 timeout,而那时
    // 调用方(关弹窗 / 组件卸载)早已不会再调 stop() —— 守卫若只看 genIdRef(只由
    // generate() 递增),这次响应就会通过,轮到一条挂在死组件 ref 上的僵尸链永远 2s 打后端。
    // 用户报的「界面关了,后端还在一直 GET /api/images/N」正是这条。
    cancelRef.current += 1;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setGenerating(false);
    setError(null);
    setCredsMissing(false);
  }, [stop]);

  // 卸载时清理轮询。
  useEffect(() => stop, [stop]);

  // 失败分类:isCredentialsError(msg) → 缺凭据;否则原文。同时调用方可经 onFail 接管(MediaStudio)。
  const handleFail = useCallback((msg, perCall) => {
    stop();
    setGenerating(false);
    const m = msg || '';
    const creds = isCredentialsError(m);
    if (perCall && perCall.onFail) { perCall.onFail(m, { creds }); return; }
    if (onFail) { onFail(m, { creds }); return; }
    if (creds) { setCredsMissing(true); setError(perCall && perCall.credsErrorText ? perCall.credsErrorText : null); }
    else { setCredsMissing(false); setError(m || '操作失败'); }
  }, [stop, onFail]);

  const handleDone = useCallback((url, imageId, pollResult) => {
    stop();
    setGenerating(false);
    // 就地广播一条与后端 SSE 同形状的事件(`rpg-image-updated` / op=ready)。
    // 为什么必须由前端补这一枪:生图实际由**独立进程**(postproc worker)执行,它写库后发的
    // SSE 事件是跨进程投递 —— 只有配了 Redis 才到得了浏览器。没配 Redis 时(dev/单机的默认
    // 形态)聊天里的图要刷新页面才出现(用户上报)。这个浏览器自己知道结果,补一条同形状事件
    // 即可实时追加;真收到服务端事件时,消费方按 image_id 去重,不会重复。
    try {
      window.dispatchEvent(new CustomEvent('rpg-image-updated', {
        detail: { op: 'ready', payload: { image_id: imageId, url, kind: kindRef.current }, ts: Date.now() },
      }));
    } catch (_) { /* 事件派发失败不影响生图结果本身 */ }
    // 第三参 = 整份轮询响应(含 ref_dropped 等标记),宿主据此展示结果态提示;老宿主只取前两参不受影响。
    if (onDone) onDone(url, imageId, pollResult);
  }, [stop, onDone]);

  const poll = useCallback((imageId, perCall, myGen, attempt) => {
    const pc = perCall || {};
    const intervalMs = 2000;
    const catchMs = Number.isFinite(pc.pollCatchMs) ? pc.pollCatchMs : 2000;
    const maxAttempts = Number.isFinite(pc.maxPollAttempts) ? pc.maxPollAttempts : POLL_MAX_ATTEMPTS;
    const n = Number.isFinite(attempt) ? attempt : 0;
    stop();
    // 必须在 stop() **之后**取纪元:stop() 自己会推进它,先取会把本轮立刻判成陈旧(自锁死)。
    // 之后任何一次 stop()(关弹窗/卸载/收尾)都会让在途响应失效,链条不会再复活。
    const myCancel = cancelRef.current;
    const stale = () => genIdRef.current !== myGen || cancelRef.current !== myCancel;
    if (n >= maxAttempts) { handleFail(pc.pollTimeoutMsg || '生图超时:未能确认结果', pc); return; }
    (async () => {
      try {
        const r = await window.api.images.get(imageId);
        if (stale()) return;  // 陈旧轮次(被新 generate 取代,或调用方已 stop)
        if (!r) {
          if (pc.emptyResStops) { handleFail(pc.emptyResMsg || '轮询返回空响应', pc); return; }
          pollRef.current = setTimeout(() => poll(imageId, pc, myGen, n + 1), intervalMs);
          return;
        }
        const status = pc.doneFromStatus ? pc.doneFromStatus(r) : r.status;
        if (status === 'done' && (!pc.requireUrl || r.url)) { handleDone(r.url, imageId, r); return; }
        // cancelled 是**终态**(后端取消接口与 wait_for_image 都这么算),此前只认 done/failed,
        // 于是移动端取消过的图在桌面端会被永远轮询 —— 状态不会再变,循环没有出口。
        if (status === 'failed' || status === 'cancelled') { handleFail(r.error || pc.failFallback || '生成失败', pc); return; }
        pollRef.current = setTimeout(() => poll(imageId, pc, myGen, n + 1), intervalMs);
      } catch (e) {
        if (stale()) return;  // 陈旧轮次
        if (pc.catchStops) { handleFail((e && e.message) || pc.pollCatchMsg || '轮询出错', pc); return; }
        pollRef.current = setTimeout(() => poll(imageId, pc, myGen, n + 1), catchMs);
      }
    })();
  }, [stop, handleDone, handleFail]);

  const generate = useCallback(async (body, perCall) => {
    const pc = perCall || {};
    const myGen = ++genIdRef.current;  // 每次生成递增,供 poll 的陈旧守卫比对
    kindRef.current = (body && body.kind) || '';
    setError(null);
    setCredsMissing(false);
    setGenerating(true);
    try {
      const r = await window.api.images.generate(body);
      if (genIdRef.current !== myGen) return;  // generate() 已被新调用取代
      if (pc.inspect && pc.inspect(r, { fail: (m) => handleFail(m, pc) })) return;
      if (r && r.image_id) { poll(r.image_id, pc, myGen); return; }
      if (pc.noImageIdMsg) { handleFail(pc.noImageIdMsg, pc); return; }
      handleFail(r && r.error, pc);
    } catch (e) {
      if (pc.rawCatch) {
        // MediaStudio 语义:catch 只把 e.message 交给 fail(),由 fail() 的 creds 正则自行分类(逐字保留)。
        handleFail((e && e.message) || pc.genericErrorMsg || '', pc);
        return;
      }
      // GenerateImageModal 语义:creds 可能藏在 e / e.payload.detail|error 里 —— 预分类后给 detail。
      const errMsg = (e && e.message) || pc.genericErrorMsg || '请求失败';
      const payload = e && e.payload;
      const detail = (payload && (payload.detail || payload.error)) || errMsg;
      const creds = isCredentialsError(e) || isCredentialsError(detail);
      handleFail(creds ? 'credentials_required' : detail, pc);
    }
  }, [poll, handleFail]);

  return { generate, generating, error, credsMissing, reset, stop, setError, setCredsMissing };
}

export default useImageGeneration;
