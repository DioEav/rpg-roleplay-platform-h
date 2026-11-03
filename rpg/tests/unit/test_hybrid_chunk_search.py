"""test_hybrid_chunk_search — 阶段 3 混合检索/可选 rerank 回归。

覆盖:
  · 向量候选 + 关键词候选 RRF 融合,同一 id 两路命中分数相加;
  · 向量路存在时最终按章节顺序(给 GM 时间线),关键词单路保留 score 降序;
  · rerank 默认关闭;开启后按 LLM 返回 id 顺序重排,失败/非法输出原样返回。
"""
from __future__ import annotations

from unittest.mock import patch

from platform_app.knowledge._search import _maybe_llm_rerank, _search_chunks


class _Cur:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _DB:
    def __init__(self, vector_rows, keyword_rows):
        self.vector_rows = vector_rows
        self.keyword_rows = keyword_rows

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split()).lower()
        if "embedding_vec <=>" in s:
            return _Cur(self.vector_rows)
        if "content ilike" in s:
            return _Cur(self.keyword_rows)
        return _Cur([])


def _row(i, ch, txt="片段"):
    return {"id": i, "chapter_index": ch, "content": txt, "metadata": {}}


def _run(db, top_k=3):
    with patch("platform_app.knowledge._search._embed_query", return_value="[1,2]"), \
         patch("platform_app.knowledge._search._vector_column_exists", return_value=True), \
         patch.dict("os.environ", {"RPG_RAG_RERANK": "off"}):
        return _search_chunks(db, 7, ["青铜短刀"], None, None, top_k)


def test_rrf_fuses_vector_and_keyword_and_orders_by_chapter():
    vec = [{**_row(1, 1), "score": 0.9}, {**_row(2, 1), "score": 0.8}]
    kw = [{**_row(2, 1), "score": 2}, {**_row(3, 2), "score": 1}]
    out = _run(_DB(vec, kw))
    ids = [r["id"] for r in out]
    assert ids == [2, 1, 3], "向量路存在时最终按章节顺序;同章内 fused 分高者在前"
    # id2 两路都命中,fused 分应高于只命中一路的 id1/id3
    scores = {r["id"]: r["score"] for r in out}
    assert scores[2] > scores[1] and scores[2] > scores[3]


def test_keyword_only_exact_hit_not_crowded_out_by_vector_candidates():
    """top_k 很小时,只在关键词路命中的专名/物品不能被纯向量候选挤掉。"""
    vec = [{**_row(1, 1), "score": 0.9}, {**_row(2, 1), "score": 0.8}]
    kw = [{**_row(3, 2), "score": 1}]
    out = _run(_DB(vec, kw), top_k=2)
    assert 3 in [r["id"] for r in out], "关键词路独有的精确命中必须保留一个位置"


def test_keyword_only_keeps_score_order():
    kw = [{**_row(2, 1), "score": 3}, {**_row(3, 2), "score": 1}]
    with patch("platform_app.knowledge._search._embed_query", return_value=None), \
         patch("platform_app.knowledge._search._vector_column_exists", return_value=True), \
         patch.dict("os.environ", {"RPG_RAG_RERANK": "off"}):
        out = _search_chunks(_DB([], kw), 7, ["青铜短刀"], None, None, 3)
    assert [r["id"] for r in out] == [2, 3], "关键词单路保留 score 降序,不被章节序打散"


def test_vector_only_orders_by_chapter():
    vec = [{**_row(2, 2), "score": 0.9}, {**_row(1, 1), "score": 0.8}]
    out = _run(_DB(vec, []))
    assert [r["id"] for r in out] == [1, 2]


def test_rerank_off_by_default():
    rows = [_row(1, 1), _row(2, 2)]
    with patch.dict("os.environ", {"RPG_RAG_RERANK": "off"}):
        assert _maybe_llm_rerank(["x"], rows, user_id=1) is rows


def test_rerank_on_reorders_by_llm_order(monkeypatch):
    monkeypatch.setenv("RPG_RAG_RERANK", "1")
    rows = [_row(1, 1), _row(2, 2), _row(3, 3)]
    with patch("agents._harness.resolve_api_and_model", return_value=("api", "model")), \
         patch("agents._harness.call_agent_json_guarded",
               return_value=("[3,1,2]", {})):
        out = _maybe_llm_rerank(["x"], rows, user_id=1)
    assert [r["id"] for r in out] == [3, 1, 2]


def test_rerank_failure_keeps_original_order(monkeypatch):
    monkeypatch.setenv("RPG_RAG_RERANK", "1")
    rows = [_row(1, 1), _row(2, 2)]
    with patch("agents._harness.resolve_api_and_model", return_value=("api", "model")), \
         patch("agents._harness.call_agent_json_guarded",
               side_effect=RuntimeError("timeout")):
        out = _maybe_llm_rerank(["x"], rows, user_id=1)
    assert out == rows
