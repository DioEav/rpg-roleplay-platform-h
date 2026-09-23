import React from 'react';
import { useTranslation } from 'react-i18next';
import CSModal from '@cloudscape-design/components/modal';
import CSBox from '@cloudscape-design/components/box';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSFormField from '@cloudscape-design/components/form-field';
import CSTextarea from '@cloudscape-design/components/textarea';
import CSAlert from '@cloudscape-design/components/alert';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import AgentModelPicker from './AgentModelPicker.jsx';
import ImageSizePicker from './ImageSizePicker.jsx';
import ReferenceImagePicker from './ReferenceImagePicker.jsx';
import AvatarImg from './AvatarImg.jsx';
import { chatImageAnchor } from './game/chat-image-anchor.js';
import { useImageGeneration } from '../hooks/useImageGeneration.js';
import { plGoto } from '../router.js';

/* GenerateImageModal — AI 生图弹窗，复用 CSModal + AgentModelPicker 范式。

   props:
     open           : boolean  是否可见
     onClose        : ()=>void  关闭回调
     kind           : 生图类型 'cover'|'avatar'|'card'|'chat'|'game'|'persona'
     attach         : { type, id } 可选，生成后写入目标
     defaultPrompt  : 默认 prompt 文本
     onDone         : (url:string)=>void  生成成功并获得 URL 后回调

   内部流程:
     1. 点「生成」→ POST /api/images/generate → {image_id, status:'pending'}
     2. 每 2s 轮询 GET /api/images/{image_id} 直到 status==='done' 或 'failed'
     3. done → **留在弹窗里就地展示结果**（点图看大图）+ 调宿主 onDone(url)
        —— 不再自动关闭：此前直接 onClose() 而宿主 onDone 是空实现，用户既看不到图、
        URL 也被丢弃，只留下"弹窗一闪就没了"（用户上报）。关窗不取消后端任务，
        图已经存进图库，所以留窗展示不会丢结果。
     4. failed / credentials_required → 显示错误提示
*/
export default function GenerateImageModal({
  open,
  onClose,
  kind = 'avatar',
  attach,
  defaultPrompt = '',
  onDone,
  saveId,
}) {
  const { useState, useEffect } = React;
  const { t } = useTranslation();

  const [prompt, setPrompt] = useState(defaultPrompt);
  const [size, setSize] = useState('');
  const [refs, setRefs] = useState([]);   // 参考图(i2i)站内 URL 列表,≤4 张
  const [selModel, setSelModel] = useState({ api_id: '', model: '' });
  // 生成成功后的结果 URL。非空 = 弹窗切到「结果视图」（不再自动关闭）。
  const [doneUrl, setDoneUrl] = useState('');
  // 后端标记「参考图被忽略」(尝试链全部降级到纯 t2i,见 openai_compat) → 结果视图提示条。
  const [refDropped, setRefDropped] = useState(false);

  // 生图内核(generate + 每 2s 轮询 + creds 分类)收口到 useImageGeneration;busy/error/credsMissing
  // 取自 hook。done → 就地展示结果 + 透传宿主 onDone(url, imageId, 轮询响应);聊天里的实时追加由 hook
  // 成功时广播的本地 rpg-image-updated 事件负责(不依赖 Redis)。
  const CREDS_TEXT = t('components.generate_image_modal.creds_missing_hint');
  const { generate, generating: busy, error, credsMissing, reset, stop, setError } = useImageGeneration({
    onDone: (url, imageId, pollResult) => {
      const dropped = !!(pollResult && pollResult.ref_dropped);
      setRefDropped(dropped);
      if (dropped) {
        window.__apiToast?.(t('components.generate_image_modal.ref_dropped_note'), { kind: 'warn', duration: 5000 });
      }
      setDoneUrl(url);
      if (onDone) onDone(url, imageId, pollResult);
    },
  });
  // 反馈采集:生图弹窗(无独立路由)标记当前活跃功能供运行环境快照识别。
  useEffect(() => {
    if (!open) return;
    try { window.__activeFeature = 'AI 生图'; } catch (_) {}
    return () => { try { if (window.__activeFeature === 'AI 生图') window.__activeFeature = null; } catch (_) {} };
  }, [open]);
  // perCall:逐字保留本组件原 done/fail/error 文案与轮询策略。
  const PER_CALL = {
    noImageIdMsg: t('components.generate_image_modal.error.no_image_id'),   // 响应无 image_id(含 !res)→ 报错
    failFallback: t('components.generate_image_modal.error.generate_failed'),               // failed 取错文兜底
    credsErrorText: CREDS_TEXT,             // creds 时显示该文 + credsMissing 旗标
    emptyResStops: true, emptyResMsg: t('components.generate_image_modal.error.poll_empty'),   // 轮询空响应:停并报错
    catchStops: true, pollCatchMsg: t('components.generate_image_modal.error.poll_error'),           // 轮询 catch:停并报错(不再重试)
    genericErrorMsg: t('components.generate_image_modal.error.request_failed'),
  };

  // 当 defaultPrompt 变化(如父组件切换上下文)时同步
  useEffect(() => {
    setPrompt(defaultPrompt);
  }, [defaultPrompt]);

  // 弹窗关闭时清理轮询(仅停轮询,逐字保留原行为:不在此清 error/credsMissing,那由 handleClose 做)。
  useEffect(() => {
    if (!open) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleGenerate() {
    const trimmedPrompt = (prompt || '').trim();
    if (!trimmedPrompt) {
      setError(t('components.generate_image_modal.error.prompt_required'));
      return;
    }
    if (!selModel.api_id || !selModel.model) {
      setError(t('components.generate_image_modal.error.model_required'));
      return;
    }
    const body = {
      prompt: trimmedPrompt,
      kind,
      api_id: selModel.api_id,
      model: selModel.model,
    };
    if (attach) body.attach = attach;
    if (saveId != null) body.save_id = saveId;
    if (size) body.size = size;
    // 参考图(i2i):站内 URL 列表,后端 _sanitize_refs 白名单/去重/截断 → worker 读盘成字节
    if (refs.length) body.refs = refs;
    // 存档绑定的生图把"当前最后一条助手消息的绝对索引"一起写进 ai_images.message_index。
    // **点击时**读锚点(不是 render 快照)——此后删本地对话,旧索引匹配不到任何消息,
    // 图不会漂到新对话的最新消息上(用户上报的"删了对话图片爬到新消息")。
    if (saveId != null) {
      const mi = chatImageAnchor.lastAsstKey;
      if (mi != null && mi !== '' && Number.isFinite(Number(mi)) && Number(mi) >= 0) {
        body.message_index = Number(mi);
      }
    }
    generate(body, PER_CALL);
  }

  function handleClose() {
    if (busy) return;
    reset();
    setDoneUrl('');
    setRefDropped(false);
    if (onClose) onClose();
  }

  return (
    <CSModal
      visible={!!open}
      onDismiss={handleClose}
      header={t('components.generate_image_modal.title')}
      footer={
        <CSBox float="right">
          <CSSpaceBetween direction="horizontal" size="xs">
            {/* 结果视图与表单视图的按钮组互斥(避免 SpaceBetween 收到 Fragment 子元素而丢间距) */}
            {doneUrl ? [
              <CSButton key="close" onClick={handleClose}>
                {t('components.generate_image_modal.close_btn')}
              </CSButton>,
              <CSButton key="again" variant="primary" onClick={() => { reset(); setDoneUrl(''); setRefDropped(false); }}>
                {t('components.generate_image_modal.regenerate_btn')}
              </CSButton>,
            ] : [
              <CSButton key="cancel" onClick={handleClose} disabled={busy}>{t('common.cancel')}</CSButton>,
              <CSButton
                key="gen"
                variant="primary"
                loading={busy}
                disabled={busy || !(prompt || '').trim()}
                onClick={handleGenerate}
              >
                {t('components.generate_image_modal.generate_btn')}
              </CSButton>,
            ]}
          </CSSpaceBetween>
        </CSBox>
      }
    >
      {doneUrl ? (
        <CSSpaceBetween size="m">
          <CSBox variant="h3">{t('components.generate_image_modal.result_title')}</CSBox>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {/* AvatarImg 自带「点击开全屏」(zoomable → ImageLightbox),无需另外接线;
                加载失败时它自己降级成占位,不会露出破图。 */}
            <AvatarImg
              src={doneUrl}
              name={t('components.generate_image_modal.result_title')}
              size={220}
              shape="rounded"
              zoomable
            />
          </div>
          <CSBox color="text-body-secondary" fontSize="body-s">
            {refDropped && (
              <CSAlert type="warning" header={t('components.generate_image_modal.ref_dropped_note')}>
                {t('components.generate_image_modal.ref_dropped_hint')}
              </CSAlert>
            )}
            {t('components.generate_image_modal.result_saved_hint')}
          </CSBox>
          {prompt ? (
            <CSBox fontSize="body-s">
              <span className="muted-2">{t('components.generate_image_modal.result_prompt_label')}</span>
              {' '}{prompt}
            </CSBox>
          ) : null}
        </CSSpaceBetween>
      ) : (
      <CSSpaceBetween size="m">
        {busy && (
          <CSStatusIndicator type="loading">
            {t('components.generate_image_modal.generating')}
          </CSStatusIndicator>
        )}
        {error && (
          <CSAlert
            type="error"
            header={credsMissing ? t('components.generate_image_modal.error.missing_api_key') : t('components.generate_image_modal.error.generate_failed')}
            action={credsMissing
              ? <CSButton iconName="settings" onClick={() => { plGoto('settings-models'); }}>{t('components.generate_image_modal.configure_key_btn')}</CSButton>
              : undefined
            }
          >
            {error}
          </CSAlert>
        )}
        <CSFormField
          label={t('components.generate_image_modal.prompt_label')}
          description={t('components.generate_image_modal.prompt_description')}
        >
          <CSTextarea
            value={prompt}
            onChange={({ detail }) => setPrompt(detail.value)}
            placeholder={t('components.generate_image_modal.prompt_placeholder')}
            rows={3}
            disabled={busy}
          />
        </CSFormField>
        <AgentModelPicker
          prefPrefix="image_gen"
          fallbackPrefix="gm"
          capabilityFilter="image_gen"
          variant="bare"
          header={undefined}
          description={t('components.generate_image_modal.model_picker_description')}
          configHash="settings-models"
          onChange={(api_id, model) => setSelModel({ api_id, model })}
        />
        <CSFormField label={t('components.generate_image_modal.size_label')} description={t('components.generate_image_modal.size_description')}>
          <ImageSizePicker kind={kind} value={size} onChange={setSize} />
        </CSFormField>
        {/* 参考图(i2i):自带 label/说明,不套 CSFormField(它已有自己的 .rif 结构) */}
        <ReferenceImagePicker refs={refs} onChange={setRefs} />
      </CSSpaceBetween>
      )}
    </CSModal>
  );
}
