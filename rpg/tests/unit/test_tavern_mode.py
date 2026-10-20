"""酒馆模式(Tavern Mode)回归测试。

覆盖:
  · content_pack 解析 → tavern_gm,且 provider 只产角色/persona 层,无 anchor/script 层
  · 工具可见性:tavern_gm 丢锚点/剧本/战斗,保留 memory/关系/世界书 overlay(决策4 持久记忆)
  · create_tavern_save:save_kind/script_id NULL/快照形状/first_mes 开场/character_book→overlay
  · save_to_chat_jsonl ↔ parse_chat_jsonl 文本无损往返(决策2)
  · save_io.import_save:tavern lane(script_id NULL)+ game lane 零回归

DB 类测试若本地无用户则 skip(纯逻辑测试始终运行)。所有创建的行在 tearDown 清理。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


# ── 纯逻辑(无 DB)──────────────────────────────────────────────────────────
class TavernManifestAndProvider(unittest.TestCase):
    def test_manifest_resolves_to_tavern_gm(self):
        from context_providers import DEFAULT_TAVERN_MANIFEST, resolve_content_pack

        class S:
            data = {"content_pack": DEFAULT_TAVERN_MANIFEST}
        m = resolve_content_pack(S())
        self.assertEqual(m["kind"], "tavern")
        self.assertEqual(m["gm_policy"]["mode"], "tavern_gm")
        # 无剧本:manifest 不含 anchor/script provider
        provs = m["context_providers"]
        self.assertIn("tavern_character", provs)
        self.assertIn("memory", provs)
        self.assertNotIn("script_phase_anticipation", provs)
        self.assertNotIn("novel_retrieval", provs)

    def test_provider_emits_character_persona_no_script_layers(self):
        from context_providers import get_provider
        from context_providers.base import Demand

        class S:
            data = {
                "tavern": {
                    "character": {"name": "伊蕾娜", "personality": "冷淡", "sample_dialogue": ["哼。"]},
                    "system_prompt": "始终第一人称。",
                    "scenario": "雨夜酒馆。",
                },
                "player": {"name": "阿白", "role": "旅人"},
            }
        contrib = get_provider("tavern_character").collect(S(), {}, Demand.empty(), None)
        ids = {layer["id"] for layer in contrib.layers}
        self.assertEqual(ids, {"tavern_card_system", "tavern_character", "tavern_persona"})
        # 卡内 system_prompt 走最高优先级层(强制注入)
        sys_layer = next(layer for layer in contrib.layers if layer["id"] == "tavern_card_system")
        self.assertGreaterEqual(sys_layer["priority"], 95)
        self.assertIn("始终第一人称", sys_layer["content"])

    def test_provider_skips_when_no_tavern_state(self):
        from context_providers import get_provider

        class S:
            data = {"player": {"name": "x"}}
        self.assertFalse(get_provider("tavern_character").applies(S(), {}, None))


class TavernToolVisibility(unittest.TestCase):
    def test_tavern_full_agent_drops_only_canon(self):
        # 酒馆 = 完整 harness agent:无绑定剧本只丢 canon 读/写;绑定只读剧本仅禁 canon 写(kb_)。
        # 非酒馆(游戏控制台 mode=None)反过来:丢掉酒馆自管理工具,别污染游戏工具表。
        from tools_dsl.chat_tool_router import build_unified_tool_list
        from tools_dsl.command_tools_register import ensure_registered
        ensure_registered()
        nontavern = {d["name"] for d in build_unified_tool_list(None, origin="llm_chat")}
        tav = {d["name"] for d in build_unified_tool_list(None, origin="llm_chat", mode="tavern_gm")}
        # 酒馆保留:记忆/关系/世界书 overlay/clarify(+ 战斗/物品/模组等完整 agent 工具)
        for keep in ("add_memory_fact", "set_relationship", "worldbook_add", "clarify"):
            self.assertIn(keep, tav, f"{keep} 酒馆应保留")
        # 酒馆自管理工具:酒馆里在、游戏控制台里不在(不污染、不抢 _rank 窗口)
        self.assertIn("edit_tavern_character", tav, "酒馆应有自管理工具")
        for tname in ("set_tavern_character", "edit_tavern_character", "tavern_list_scripts"):
            self.assertNotIn(tname, nontavern, f"{tname} 不应出现在非酒馆(游戏)工具表")
        # 无绑定剧本:canon 读/写工具无对象 → 丢
        for drop in ("search_canon", "kb_upsert_entity"):
            self.assertNotIn(drop, tav, f"{drop}(canon)无剧本时应丢")
        # 绑定只读剧本:canon 读放开(贴合原著),仅 canon 写(kb_)仍禁
        tav_b = {d["name"] for d in build_unified_tool_list(
            None, origin="llm_chat", mode="tavern_gm", bound_script_id=7)}
        self.assertIn("search_canon", tav_b, "绑定后 canon 读应放开")
        self.assertNotIn("kb_upsert_entity", tav_b, "绑定只读剧本后 canon 写(kb_)仍禁")


# ── DB 集成(需本地有用户;否则 skip)─────────────────────────────────────────
def _first_user_id():
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute("select id from users order by id limit 1").fetchone()
        return row["id"] if row else None
    except Exception:
        return None


@unittest.skipUnless(_first_user_id() is not None, "本地无用户,跳过 DB 集成测试")
class TavernSaveLifecycle(unittest.TestCase):
    def setUp(self):
        from platform_app import user_cards
        self.uid = _first_user_id()
        self._card_ids: list[int] = []
        self._save_ids: list[int] = []
        card = user_cards.upsert_user_card(self.uid, {
            "name": "测试酒馆角色",
            "identity": "流浪剑客", "personality": "冷淡毒舌",
            "metadata": {
                "first_mes": "……找我有事？",
                "system_prompt": "第一人称，绝不出戏。",
                "scenario": "雨夜酒馆。",
                "character_book": {"entries": [
                    {"keys": ["剑"], "content": "她的断剑名为'残'。", "comment": "武器", "priority": 70},
                    {"keys": ["x"], "content": "禁用条目", "enabled": False},
                ]},
            },
        })
        self.card_id = card["id"]
        self._card_ids.append(self.card_id)

    def tearDown(self):
        from platform_app.db import connect
        with connect() as db:
            for sid in self._save_ids:
                db.execute("delete from game_saves where id=%s", (sid,))
            for cid in self._card_ids:
                db.execute("delete from character_cards where id=%s", (cid,))

    def test_create_tavern_save_shape_and_overlay(self):
        from platform_app import workspace
        from platform_app.db import connect
        save = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(save["id"])
        with connect() as db:
            row = db.execute(
                "select script_id, save_kind, tavern_character_card_id, state_snapshot "
                "from game_saves where id=%s", (save["id"],),
            ).fetchone()
            snap = row["state_snapshot"]
            self.assertIsNone(row["script_id"])
            self.assertEqual(row["save_kind"], "tavern")
            self.assertEqual(row["tavern_character_card_id"], self.card_id)
            self.assertEqual((snap.get("content_pack") or {}).get("gm_policy", {}).get("mode"), "tavern_gm")
            self.assertEqual((snap.get("tavern") or {}).get("system_prompt"), "第一人称，绝不出戏。")
            # first_mes 进 history(开场 assistant)
            hist = snap.get("history") or []
            self.assertTrue(any(h.get("role") == "assistant" and "找我有事" in h.get("content", "") for h in hist))
            # character_book → save_worldbook_overlays(禁用条目被跳过 → 仅 1 条)
            ov = db.execute("select count(*) c from save_worldbook_overlays where save_id=%s", (save["id"],)).fetchone()
            self.assertEqual(ov["c"], 1)

    def test_first_mes_commit_turn_index_zero(self):
        """BUGFIX(回退多删一轮):first_mes 开场 round commit 的 turn_index 必须为 0,与 GM 运行期
        开场(record_runtime_turn 用 data['turn']=history_len//2)对齐。否则前端按 msg_index//2
        回退会命中早一个 turn → continue_from 多截一轮。"""
        from platform_app import workspace
        from platform_app.branches.tree_ops import resolve_commit_id_by_message
        from platform_app.db import connect
        save = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(save["id"])
        sid = int(save["id"])
        with connect() as db:
            rows = db.execute(
                "select id, turn_index, kind, gm_output from branch_commits where save_id=%s order by turn_index, id",
                (sid,),
            ).fetchall()
        # first_mes 开场必须是 turn_index=0 的 round commit(不是 turn 1)
        opening_rounds = [r for r in rows if r["kind"] == "round" and int(r["turn_index"]) == 0
                          and "找我有事" in (r.get("gm_output") or "")]
        self.assertTrue(opening_rounds, f"first_mes 开场应在 turn_index 0;实际 commits={[(r['kind'], r['turn_index']) for r in rows]}")
        # 回退到开场(msg_index=0)应命中 first_mes 的 round commit(turn 0,id>root),而非把它一起删掉
        cid = resolve_commit_id_by_message(self.uid, sid, 0)
        self.assertEqual(cid, int(opening_rounds[0]["id"]))

    def test_chat_jsonl_round_trip(self):
        from platform_app import tavern_chats, workspace
        save = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(save["id"])
        text = tavern_chats.save_to_chat_jsonl(save["id"])
        header, commits = tavern_chats.parse_chat_jsonl(text)  # 应无异常
        self.assertEqual(header["character_name"], "测试酒馆角色")
        self.assertTrue(len(commits) >= 1)


@unittest.skipUnless(_first_user_id() is not None, "本地无用户,跳过 DB 集成测试")
class ForkTavernSave(unittest.TestCase):
    """fork_tavern_save:克隆截断状态为新对话,源档零改动。

    合约:切点解析复用 resolve_commit_id_by_message(与游戏台 fork/rollback 同一套
    开场相位判定);新对话包含到所选消息为止——前端对角色回复传 message_index+1、
    对玩家输入传原 index(与游戏台同口径,玩家那句留给新对话里重说)。
    """

    def setUp(self):
        from platform_app import user_cards
        self.uid = _first_user_id()
        self._card_ids: list[int] = []
        self._save_ids: list[int] = []
        card = user_cards.upsert_user_card(self.uid, {
            "name": "测试酒馆角色",
            "identity": "流浪剑客", "personality": "冷淡毒舌",
            "metadata": {
                "first_mes": "……找我有事？",
                "system_prompt": "第一人称，绝不出戏。",
                "scenario": "雨夜酒馆。",
            },
        })
        self.card_id = card["id"]
        self._card_ids.append(self.card_id)

    def tearDown(self):
        from platform_app.db import connect
        with connect() as db:
            for sid in self._save_ids:
                db.execute("delete from game_saves where id=%s", (sid,))
            for cid in self._card_ids:
                db.execute("delete from character_cards where id=%s", (cid,))

    def test_fork_at_first_mes_inclusive_and_source_untouched(self):
        from platform_app import workspace
        from platform_app.db import connect
        src = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(src["id"])
        with connect() as db:
            src_commits = db.execute(
                "select count(*) c from branch_commits where save_id=%s", (src["id"],),
            ).fetchone()["c"]
            src_active = db.execute(
                "select coalesce(active_commit_id, active_branch_node_id) cid from game_saves where id=%s",
                (src["id"],),
            ).fetchone()["cid"]
        # first_mes 在 history idx0(assistant);前端 +1 → message_index=1。
        # resolve(1) → (1-1)//2=0 → 开场 round commit → 新对话含 first_mes(含式合约)。
        forked = workspace.fork_tavern_save(self.uid, src["id"], message_index=1, title="分支测试")
        self._save_ids.append(forked["id"])
        self.assertEqual(forked["save_kind"], "tavern")
        self.assertIsNone(forked["script_id"])
        self.assertEqual(forked["title"], "分支测试")
        self.assertEqual(forked["tavern_character_card_id"], self.card_id)
        snap = forked["state_snapshot"]
        hist = snap.get("history") or []
        self.assertEqual(len(hist), 1)
        self.assertIn("找我有事", hist[0].get("content", ""))
        self.assertEqual(snap.get("turn"), 0)
        # tavern 块按统一卡库最新值刷新(system_prompt 来自卡片 metadata)
        self.assertEqual((snap.get("tavern") or {}).get("system_prompt"), "第一人称，绝不出戏。")
        # 新树已 seed:root + 开场 round(turn_index=0)
        with connect() as db:
            rows = db.execute(
                "select kind, turn_index from branch_commits where save_id=%s order by turn_index, id",
                (forked["id"],),
            ).fetchall()
            src_commits_after = db.execute(
                "select count(*) c from branch_commits where save_id=%s", (src["id"],),
            ).fetchone()["c"]
            src_active_after = db.execute(
                "select coalesce(active_commit_id, active_branch_node_id) cid from game_saves where id=%s",
                (src["id"],),
            ).fetchone()["cid"]
        self.assertTrue(any(r["kind"] == "root" for r in rows))
        self.assertTrue(any(r["kind"] == "round" and int(r["turn_index"]) == 0 for r in rows))
        # 源档零改动:commit 数与活跃指针前后一致
        self.assertEqual(src_commits_after, src_commits)
        self.assertEqual(src_active_after, src_active)

    def test_fork_at_root_node_gives_empty_history(self):
        from platform_app import workspace
        from platform_app.db import connect
        src = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(src["id"])
        with connect() as db:
            root = db.execute(
                "select id from branch_commits where save_id=%s and kind='root' order by id limit 1",
                (src["id"],),
            ).fetchone()
        forked = workspace.fork_tavern_save(self.uid, src["id"], node_id=int(root["id"]))
        self._save_ids.append(forked["id"])
        self.assertEqual(forked["state_snapshot"].get("history") or [], [])
        self.assertEqual(forked["state_snapshot"].get("turn"), 0)

    def test_fork_default_title_suffix(self):
        from platform_app import workspace
        src = workspace.create_tavern_save(self.uid, self.card_id)
        self._save_ids.append(src["id"])
        forked = workspace.fork_tavern_save(self.uid, src["id"], message_index=1)
        self._save_ids.append(forked["id"])
        self.assertEqual(forked["title"], f"{src['title']} · 分支")

    def test_fork_imported_lane_replays_history(self):
        """导入型提交(save_io.import_save lane)无 state_snapshot → fork 按
        player_input/gm_output 重放重建 history。"""
        from platform_app import save_io, tavern_chats, workspace
        text = ('{"user_name":"我","character_name":"小红","create_date":""}\n'
                '{"name":"我","is_user":true,"mes":"你好"}\n'
                '{"name":"小红","is_user":false,"mes":"嗯？"}')
        header, commits = tavern_chats.parse_chat_jsonl(text)
        payload = tavern_chats.chat_to_save_payload(header, commits)
        res = save_io.import_save(self.uid, payload)
        src_id = res["save_id"]
        self._save_ids.append(src_id)
        # history = [user 你好, gm 嗯？](无开场,offset=0);GM 在 idx1 → +1=2
        # → turn 1,血缘无 turn 1 → 兜底取 <=1 最近(即唯一 commit)→ 重放两条消息。
        forked = workspace.fork_tavern_save(self.uid, src_id, message_index=2)
        self._save_ids.append(forked["id"])
        hist = forked["state_snapshot"].get("history") or []
        self.assertEqual(len(hist), 2)
        self.assertEqual(hist[0].get("role"), "user")
        self.assertIn("你好", hist[0].get("content", ""))
        self.assertEqual(hist[1].get("role"), "assistant")
        self.assertIn("嗯？", hist[1].get("content", ""))


@unittest.skipUnless(_first_user_id() is not None, "本地无用户,跳过 DB 集成测试")
class ImportSaveTavernLane(unittest.TestCase):
    def setUp(self):
        self.uid = _first_user_id()
        self._save_ids: list[int] = []

    def tearDown(self):
        from platform_app.db import connect
        with connect() as db:
            for sid in self._save_ids:
                db.execute("delete from game_saves where id=%s", (sid,))

    def test_tavern_payload_creates_null_script_save(self):
        from platform_app import save_io, tavern_chats
        text = ('{"user_name":"我","character_name":"小红","create_date":""}\n'
                '{"name":"我","is_user":true,"mes":"你好"}\n'
                '{"name":"小红","is_user":false,"mes":"嗯？"}')
        header, commits = tavern_chats.parse_chat_jsonl(text)
        payload = tavern_chats.chat_to_save_payload(header, commits)
        self.assertEqual(payload["save"]["save_kind"], "tavern")
        res = save_io.import_save(self.uid, payload)
        self._save_ids.append(res["save_id"])
        self.assertIsNone(res["script_id"])
        self.assertEqual(res["save_kind"], "tavern")


if __name__ == "__main__":
    unittest.main()
