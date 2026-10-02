/* CanonEntityEditorView — inline table editor for kb_canon_entities.
   No modal dialogs. SplitPanel for detail. Inline confirmation for delete.
   AWS Cloudscape Design System throughout.
   Mechanically extracted from pages/script-edit-canon.jsx (zero behavior change). */

import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import CSHeader from '@cloudscape-design/components/header';
import CSTable from '@cloudscape-design/components/table';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSBadge from '@cloudscape-design/components/badge';
import CSAlert from '@cloudscape-design/components/alert';
import CSInput from '@cloudscape-design/components/input';
import CSSelect from '@cloudscape-design/components/select';
import CSTextFilter from '@cloudscape-design/components/text-filter';
import CSPagination from '@cloudscape-design/components/pagination';
import DetailDrawer from '../DetailDrawer.jsx';
import CSTokenGroup from '@cloudscape-design/components/token-group';
import CSExpandableSection from '@cloudscape-design/components/expandable-section';
import CSFormField from '@cloudscape-design/components/form-field';
import CSTextarea from '@cloudscape-design/components/textarea';
import CSKeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import CSSegmentedControl from '@cloudscape-design/components/segmented-control';

/* ------------------------------------------------------------------ */
/* Constants                                                             */
/* ------------------------------------------------------------------ */
const ENTITY_TYPES = ['character', 'faction', 'location', 'item', 'concept'];
const IMPORTANCE_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));

/* ParentCombobox — portal 化的可搜索上级选择浮层。
   背景:Cloudscape Select 的下拉在组件内绝对定位渲染,表格触发横向滚动容器后被整体
   裁掉(表现为下拉被遮挡/看不到内容)。portal 到 document.body 彻底逃离任何祖先的
   overflow/层叠上下文(ImageLightbox 同款解法)。输入即筛,点击选项/回车选中,
   点击外部/Escape 取消。 */
function ParentCombobox({ anchorEl, options, onPick, onCancel, filterPlaceholder, emptyText, selectedValue }) {
  const [text, setText] = React.useState('');
  const [rect, setRect] = React.useState(null);

  React.useEffect(() => {
    if (anchorEl) setRect(anchorEl.getBoundingClientRect());
    const onDocMouseDown = (e) => {
      if (!e.target.closest || !e.target.closest('[data-parent-combobox]')) onCancel();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorEl, onCancel]);

  if (!rect) return null;
  const q = text.trim().toLowerCase();
  const filtered = (q
    ? options.filter((o) => (o.label || '').toLowerCase().includes(q))
    : options
  ).slice(0, 30);

  // 样式对齐 tokens.css 暖暗主题(panel 面 + line 线 + accent 点缀),与项目其他浮层一致
  return createPortal(
    <div data-parent-combobox style={{
      position: 'fixed', left: rect.left, top: rect.bottom + 4,
      minWidth: Math.max(rect.width, 240), maxHeight: 260, overflowY: 'auto', zIndex: 10000,
      background: 'var(--panel-2, #282623)',
      border: '1px solid var(--line-strong, #4a4540)', borderRadius: 'var(--r-2, 6px)',
      boxShadow: 'var(--shadow-1, 0 6px 18px rgba(0, 0, 0, .4))', padding: 4,
    }}>
      <input
        autoFocus
        value={text}
        placeholder={filterPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && filtered[0]) onPick(filtered[0].value); }}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 13, marginBottom: 4,
          border: '1px solid var(--line, #36322d)', borderRadius: 'var(--r-1, 4px)',
          background: 'var(--bg-deep, #131211)', color: 'var(--text, #ebe7df)',
          outline: 'none',
        }}
      />
      {filtered.length === 0 && (
        <div style={{ padding: '7px 9px', fontSize: 12.5, color: 'var(--muted-2, #6b655e)' }}>{emptyText}</div>
      )}
      {filtered.map((o) => {
        const isSelected = (o.value || '') === (selectedValue || '');
        return (
          <div
            key={o.value || '(none)'}
            onMouseDown={(e) => { e.preventDefault(); onPick(o.value); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--panel-3, #2f2c28)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? 'var(--accent-soft, rgba(201,100,66,.14))' : 'transparent'; }}
            style={{
              padding: '7px 9px', fontSize: 13, cursor: 'pointer', borderRadius: 'var(--r-1, 4px)',
              color: isSelected ? 'var(--text, #ebe7df)' : 'var(--text-quiet, #c8c2b7)',
              background: isSelected ? 'var(--accent-soft, rgba(201,100,66,.14))' : 'transparent',
            }}
          >
            {o.label}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* CanonEntityEditorView                                                 */
/* ------------------------------------------------------------------ */
export function CanonEntityEditorView({ scriptId, ownerId, currentUserId }) {
  const { t } = useTranslation();
  const readonly = ownerId != null && currentUserId != null && ownerId !== currentUserId;

  /* data */
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [reloadTick, setReloadTick] = React.useState(0);
  // 服务端分页:数据量不设上限,按页拉取;total = 当前过滤条件下的真实总数(标题计数由此驱动)
  const PAGE_SIZE = 200;
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);

  /* filters */
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState(''); // 300ms 防抖后走服务端搜索
  const [sortDesc, setSortDesc] = React.useState(true);

  /* selection / split panel */
  const [selected, setSelected] = React.useState(null); // entity object
  const [splitOpen, setSplitOpen] = React.useState(false);

  /* inline edit state — map of logical_key → { field: pendingValue } */
  const [editCell, setEditCell] = React.useState(null); // { key, field, value }

  /* new entity form */
  const [adding, setAdding] = React.useState(false);
  const [newForm, setNewForm] = React.useState({ logical_key: '', name: '', type: 'character', entity_subtype: '', importance: '3', summary: '' });

  /* delete confirmation inline */
  const [confirmDelete, setConfirmDelete] = React.useState(null); // logical_key

  /* detail panel edit */
  const [detailEdit, setDetailEdit] = React.useState({}); // pending field values for selected entity
  const [savingDetail, setSavingDetail] = React.useState(false);

  /* parent 下拉全量选项:分页后当页列表不全(且父实体可能不在本页),
     首次进入「上级」编辑时惰性拉一次全量名称表,之后缓存复用 */
  const [parentOptsAll, setParentOptsAll] = React.useState(null);
  function loadParentOptions() {
    if (parentOptsAll) return;
    fetch(`${window.__API_BASE || ''}/api/scripts/${scriptId}/canon-entities?page=1&limit=1000&order=desc`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j) ? j : (j?.items || []);
        setParentOptsAll(list.map((e) => ({ value: e.logical_key, label: e.name || e.logical_key })));
      })
      .catch(() => setParentOptsAll([]));
  }

  /* ---- fetch(服务端分页 + 过滤 + 排序) ---- */
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (typeFilter && typeFilter !== 'all') params.set('type', typeFilter);
    if (debouncedQ) params.set('q', debouncedQ);
    params.set('order', sortDesc ? 'desc' : 'asc');
    const url = `${window.__API_BASE || ''}/api/scripts/${scriptId}/canon-entities?${params}`;
    fetch(url, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setItems(Array.isArray(j) ? j : (j?.items || []));
        setTotal(Number(j?.total) || 0);
      })
      .catch(() => { if (!cancelled) { setItems([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scriptId, typeFilter, debouncedQ, sortDesc, page, reloadTick]);

  // 搜索防抖:300ms 后把输入发到服务端(q 参数),并回到第 1 页
  React.useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(query.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [query]);

  /* ---- derived(排序/搜索均已在服务端完成,直接用当页数据) ---- */
  const filtered = items;

  /* lookup parent name */
  const entityMap = React.useMemo(() => {
    const m = {};
    items.forEach((e) => { m[e.logical_key] = e; });
    return m;
  }, [items]);

  /* parent options for select */
  const parentOptions = React.useMemo(() => {
    const opts = [{ value: '', label: t('scripts.edit.canon.no_parent') }];
    items.forEach((e) => {
      if (!selected || e.logical_key !== selected.logical_key) {
        opts.push({ value: e.logical_key, label: e.name || e.logical_key });
      }
    });
    return opts;
  }, [items, selected]);

  /* ---- API calls ---- */
  async function apiPut(logicalKey, body) {
    const r = await fetch(
      `${window.__API_BASE || ''}/api/scripts/${scriptId}/canon-entities/${encodeURIComponent(logicalKey)}`,
      { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || j.detail || t('scripts.toast.save_fail'));
    return j;
  }

  async function apiPost(body) {
    const r = await fetch(
      `${window.__API_BASE || ''}/api/scripts/${scriptId}/canon-entities`,
      { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || j.detail || t('scripts.toast.save_fail'));
    return j;
  }

  async function apiDelete(logicalKey) {
    const r = await fetch(
      `${window.__API_BASE || ''}/api/scripts/${scriptId}/canon-entities/${encodeURIComponent(logicalKey)}`,
      { method: 'DELETE', credentials: 'include' }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok && j.ok !== true) throw new Error(j.error || j.detail || t('scripts.toast.delete_fail'));
    return j;
  }

  /* ---- inline cell save ---- */
  async function saveCell(entity, field, value) {
    if (readonly) return;
    const patch = { [field]: field === 'importance' ? (parseInt(value, 10) || null) : value };
    try {
      await apiPut(entity.logical_key, patch);
      setItems((arr) => arr.map((e) => e.logical_key === entity.logical_key ? { ...e, ...patch } : e));
      if (selected?.logical_key === entity.logical_key) setSelected((s) => s ? { ...s, ...patch } : s);
      window.__apiToast?.(t('scripts.toast.saved'), { kind: 'ok', duration: 1500 });
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.save_fail'), { kind: 'danger', detail: e?.message });
    }
    setEditCell(null);
  }

  /* ---- add new entity ---- */
  async function submitAdd() {
    if (readonly) return;
    const body = { ...newForm, importance: parseInt(newForm.importance, 10) || 3 };
    if (!body.logical_key || !body.name) {
      window.__apiToast?.(t('scripts.edit.canon.add_required'), { kind: 'warn' });
      return;
    }
    try {
      await apiPost(body);
      setAdding(false);
      setNewForm({ logical_key: '', name: '', type: 'character', entity_subtype: '', importance: '3', summary: '' });
      setReloadTick((x) => x + 1);
      window.__apiToast?.(t('scripts.edit.canon.add_ok'), { kind: 'ok' });
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.save_fail'), { kind: 'danger', detail: e?.message });
    }
  }

  /* ---- delete ---- */
  async function doDelete(logicalKey) {
    if (readonly) return;
    try {
      await apiDelete(logicalKey);
      setItems((arr) => arr.filter((e) => e.logical_key !== logicalKey));
      if (selected?.logical_key === logicalKey) { setSelected(null); setSplitOpen(false); }
      setConfirmDelete(null);
      window.__apiToast?.(t('scripts.edit.canon.deleted'), { kind: 'ok' });
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.delete_fail'), { kind: 'danger', detail: e?.message });
    }
  }

  /* ---- detail panel save ---- */
  async function saveDetail() {
    if (!selected || readonly) return;
    const patch = { ...detailEdit };
    if ('importance' in patch) patch.importance = parseInt(patch.importance, 10) || null;
    if ('aliases' in patch && typeof patch.aliases === 'string') {
      patch.aliases = patch.aliases.split(',').map((s) => s.trim()).filter(Boolean);
    }
    setSavingDetail(true);
    try {
      await apiPut(selected.logical_key, patch);
      const updated = { ...selected, ...patch };
      setSelected(updated);
      setItems((arr) => arr.map((e) => e.logical_key === selected.logical_key ? updated : e));
      setDetailEdit({});
      window.__apiToast?.(t('scripts.toast.saved'), { kind: 'ok' });
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.save_fail'), { kind: 'danger', detail: e?.message });
    } finally { setSavingDetail(false); }
  }

  /* ---- children lookup ---- */
  function childrenOf(logicalKey) {
    return items.filter((e) => e.parent_logical_key === logicalKey);
  }

  /* ---------------------------------------------------------------- */
  /* Render helpers                                                     */
  /* ---------------------------------------------------------------- */
  function renderTypeFilterControl() {
    const segments = [
      { id: 'all', text: t('scripts.edit.canon.type_all') },
      ...ENTITY_TYPES.map((tp) => ({ id: tp, text: t(`scripts.edit.canon.type_${tp}`) })),
    ];
    return (
      <CSSegmentedControl
        selectedId={typeFilter}
        onChange={({ detail }) => { setTypeFilter(detail.selectedId); setPage(1); }}
        options={segments}
      />
    );
  }

  /* inline editable cell — name */
  function CellName({ entity }) {
    const editing = editCell?.key === entity.logical_key && editCell?.field === 'name';
    if (editing) {
      return (
        <CSInput
          autoFocus
          value={editCell.value}
          onChange={({ detail }) => setEditCell((c) => ({ ...c, value: detail.value }))}
          onKeyDown={({ detail }) => {
            if (detail.key === 'Enter') saveCell(entity, 'name', editCell.value);
            if (detail.key === 'Escape') setEditCell(null);
          }}
          onBlur={() => saveCell(entity, 'name', editCell.value)}
        />
      );
    }
    return (
      <span
        title={entity.name || ''}
        style={{
          cursor: readonly ? 'default' : 'text',
          borderBottom: readonly ? 'none' : '1px dashed var(--color-border-divider-default, #ccc)',
          // 名称列收窄:超长单行省略(悬停看全文,点「查看明细」/详情抽屉有完整信息)
          display: 'inline-block', maxWidth: 140, verticalAlign: 'bottom',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        onClick={() => !readonly && setEditCell({ key: entity.logical_key, field: 'name', value: entity.name || '' })}
      >
        {entity.name || '—'}
      </span>
    );
  }

  /* inline editable cell — importance */
  function CellImportance({ entity }) {
    const editing = editCell?.key === entity.logical_key && editCell?.field === 'importance';
    if (editing) {
      // 数字输入而非下拉:canon importance 实际范围 1~数百(聚类次数/主角融合分),
      // 旧版写死 1-5 选项 → 编辑 >5 的行显示空白、保存还会把大值覆盖成 ≤5。
      return (
        <CSInput
          autoFocus
          inputMode="numeric"
          value={editCell.value}
          onChange={({ detail }) => setEditCell((c) => ({ ...c, value: detail.value.replace(/[^0-9]/g, '') }))}
          onKeyDown={({ detail }) => {
            if (detail.key === 'Enter') saveCell(entity, 'importance', editCell.value);
            if (detail.key === 'Escape') setEditCell(null);
          }}
          onBlur={() => saveCell(entity, 'importance', editCell.value)}
        />
      );
    }
    return (
      <span
        style={{ cursor: readonly ? 'default' : 'pointer', borderBottom: readonly ? 'none' : '1px dashed var(--color-border-divider-default, #ccc)' }}
        onClick={() => !readonly && setEditCell({ key: entity.logical_key, field: 'importance', value: String(entity.importance ?? 3) })}
      >
        {entity.importance ?? '—'}
      </span>
    );
  }

  /* inline editable cell — parent */
  function CellParent({ entity }) {
    const editing = editCell?.key === entity.logical_key && editCell?.field === 'parent_logical_key';
    const [anchorEl, setAnchorEl] = React.useState(null);
    const parentName = entity.parent_logical_key ? (entityMap[entity.parent_logical_key]?.name || entity.parent_logical_key) : '—';
    // 选项源:全量表(惰性拉取后)优先,未加载时退回当页列表;排除自己(防自指),「无上级」恒为首项
    const opts = [
      { value: '', label: t('scripts.edit.canon.no_parent') },
      ...(parentOptsAll || parentOptions).filter((o) => o.value !== entity.logical_key),
    ];
    if (editing) {
      return (
        <span
          ref={setAnchorEl}
          style={{ borderBottom: '1px dashed var(--color-border-divider-default, #ccc)', cursor: 'pointer' }}
        >
          {parentName}
          {anchorEl && (
            <ParentCombobox
              anchorEl={anchorEl}
              options={opts}
              selectedValue={editCell.value || ''}
              onPick={(v) => saveCell(entity, 'parent_logical_key', v || null)}
              onCancel={() => setEditCell(null)}
              filterPlaceholder={t('scripts.edit.canon.parent_filter_ph')}
              emptyText={t('scripts.edit.canon.empty_search')}
            />
          )}
        </span>
      );
    }
    return (
      <span
        style={{ cursor: readonly ? 'default' : 'pointer', borderBottom: readonly ? 'none' : '1px dashed var(--color-border-divider-default, #ccc)' }}
        onClick={() => { if (!readonly) { loadParentOptions(); setEditCell({ key: entity.logical_key, field: 'parent_logical_key', value: entity.parent_logical_key || '' }); } }}
      >
        {parentName}
      </span>
    );
  }

  /* inline delete confirmation row */
  function DeleteConfirmRow({ entity }) {
    if (confirmDelete !== entity.logical_key) {
      return (
        <CSButton
          variant="inline-link"
          iconName="remove"
          disabled={readonly}
          onClick={() => setConfirmDelete(entity.logical_key)}
        >
          {t('common.delete')}
        </CSButton>
      );
    }
    return (
      <CSSpaceBetween direction="horizontal" size="xs">
        <CSStatusIndicator type="warning">{t('scripts.edit.canon.confirm_delete')}</CSStatusIndicator>
        <CSButton variant="inline-link" iconName="check" onClick={() => doDelete(entity.logical_key)}>
          {t('common.confirm')}
        </CSButton>
        <CSButton variant="inline-link" iconName="close" onClick={() => setConfirmDelete(null)}>
          {t('common.cancel')}
        </CSButton>
      </CSSpaceBetween>
    );
  }

  /* ---- detail panel ---- */
  function DetailPanel({ entity }) {
    const children = childrenOf(entity.logical_key);
    const parent = entity.parent_logical_key ? entityMap[entity.parent_logical_key] : null;
    const detailVal = (field) => (field in detailEdit ? detailEdit[field] : entity[field]);
    const setDF = (field, val) => setDetailEdit((d) => ({ ...d, [field]: val }));
    const isDirty = Object.keys(detailEdit).length > 0;

    const aliases = detailVal('aliases');
    const aliasTokens = Array.isArray(aliases)
      ? aliases.map((a) => ({ label: a, dismissLabel: `Remove ${a}` }))
      : [];

    return (
      <CSSpaceBetween size="m">
        {readonly && (
          <CSAlert type="info" header={t('scripts.edit.readonly_title')}>{t('scripts.edit.readonly_body')}</CSAlert>
        )}

        <CSKeyValuePairs columns={2} items={[
          { label: t('scripts.edit.canon.field_logical_key'), value: <span className="mono">{entity.logical_key}</span> },
          { label: t('scripts.edit.canon.field_type'), value: <CSBadge color={typeBadgeColor(entity.type)}>{t(`scripts.edit.canon.type_${entity.type}`) || entity.type}</CSBadge> },
          { label: t('scripts.edit.canon.field_subtype'), value: entity.entity_subtype || '—' },
          { label: t('scripts.edit.canon.field_importance'), value: entity.importance ?? '—' },
          { label: t('scripts.edit.canon.field_first_chapter'), value: entity.first_revealed_chapter ?? '—' },
        ]} />

        <CSFormField label={t('scripts.edit.canon.field_name')}>
          <CSInput disabled={readonly} value={detailVal('name') || ''} onChange={({ detail }) => setDF('name', detail.value)} />
        </CSFormField>

        <CSFormField label={t('scripts.edit.canon.field_identity')}>
          <CSInput disabled={readonly} value={detailVal('identity') || ''} onChange={({ detail }) => setDF('identity', detail.value)} />
        </CSFormField>

        <CSFormField label={t('scripts.edit.canon.field_summary')}>
          <CSTextarea disabled={readonly} rows={3} value={detailVal('summary') || ''} onChange={({ detail }) => setDF('summary', detail.value)} />
        </CSFormField>

        <CSFormField label={t('scripts.edit.canon.field_background')}>
          <CSTextarea disabled={readonly} rows={4} value={detailVal('background') || ''} onChange={({ detail }) => setDF('background', detail.value)} />
        </CSFormField>

        <CSFormField label={t('scripts.edit.canon.field_aliases')}>
          <CSTokenGroup
            readOnly={readonly}
            items={aliasTokens}
            onDismiss={({ detail }) => {
              const updated = aliasTokens.filter((_, i) => i !== detail.itemIndex).map((t) => t.label);
              setDF('aliases', updated);
            }}
            i18nStrings={{ removeButtonAriaLabel: (t) => `Remove ${t.label}` }}
          />
          {!readonly && (
            <div style={{ marginTop: 6 }}>
              <AddAliasInput
                onAdd={(alias) => {
                  const current = Array.isArray(detailVal('aliases')) ? detailVal('aliases') : (Array.isArray(entity.aliases) ? entity.aliases : []);
                  if (alias && !current.includes(alias)) setDF('aliases', [...current, alias]);
                }}
              />
            </div>
          )}
        </CSFormField>

        {/* Tree view: parent → entity → children */}
        <CSExpandableSection headerText={t('scripts.edit.canon.tree_view')} defaultExpanded={false}>
          <CSSpaceBetween size="xs">
            {parent && (
              <div style={{ paddingLeft: 0 }}>
                <CSBox fontSize="body-s" color="text-body-secondary">
                  ↑ {t('scripts.edit.canon.parent')}: <strong>{parent.name || parent.logical_key}</strong>
                  {parent.entity_subtype ? ` (${parent.entity_subtype})` : ''}
                </CSBox>
              </div>
            )}
            <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--color-border-divider-default, #ccc)' }}>
              <CSBox fontWeight="bold">{entity.name || entity.logical_key}</CSBox>
              <CSBox fontSize="body-s" color="text-body-secondary">
                {t(`scripts.edit.canon.type_${entity.type}`) || entity.type}
                {entity.entity_subtype ? ` · ${entity.entity_subtype}` : ''}
              </CSBox>
            </div>
            {children.length > 0 && (
              <div style={{ paddingLeft: 32 }}>
                <CSBox fontSize="body-s" color="text-body-secondary">
                  ↓ {t('scripts.edit.canon.children')} ({children.length}):
                </CSBox>
                {children.map((ch) => (
                  <div key={ch.logical_key} style={{ paddingLeft: 8 }}>
                    <CSBox fontSize="body-s">
                      • <strong>{ch.name || ch.logical_key}</strong>
                      {ch.entity_subtype ? ` (${ch.entity_subtype})` : ''}
                    </CSBox>
                  </div>
                ))}
              </div>
            )}
          </CSSpaceBetween>
        </CSExpandableSection>

        {!readonly && isDirty && (
          <CSSpaceBetween direction="horizontal" size="xs">
            <CSButton variant="primary" loading={savingDetail} onClick={saveDetail}>
              {t('common.save')}
            </CSButton>
            <CSButton variant="link" onClick={() => setDetailEdit({})}>
              {t('common.cancel')}
            </CSButton>
          </CSSpaceBetween>
        )}
      </CSSpaceBetween>
    );
  }

  /* ---- new entity add row form ---- */
  function AddEntityForm() {
    return (
      <div style={{ padding: '12px 16px', background: 'var(--color-background-container-content)', border: '1px solid var(--color-border-container-top)', borderRadius: 8, marginBottom: 8 }}>
        <CSBox variant="h3" padding={{ bottom: 's' }}>{t('scripts.edit.canon.add_title')}</CSBox>
        <CSSpaceBetween direction="horizontal" size="s">
          <CSFormField label={t('scripts.edit.canon.field_logical_key')}>
            <CSInput
              placeholder="hero_01"
              value={newForm.logical_key}
              onChange={({ detail }) => setNewForm((f) => ({ ...f, logical_key: detail.value }))}
            />
          </CSFormField>
          <CSFormField label={t('scripts.edit.canon.field_name')}>
            <CSInput
              placeholder={t('scripts.edit.canon.field_name_ph')}
              value={newForm.name}
              onChange={({ detail }) => setNewForm((f) => ({ ...f, name: detail.value }))}
            />
          </CSFormField>
          <CSFormField label={t('scripts.edit.canon.field_type')}>
            <CSSelect
              selectedOption={ENTITY_TYPES.map((tp) => ({ value: tp, label: t(`scripts.edit.canon.type_${tp}`) })).find((o) => o.value === newForm.type) || null}
              options={ENTITY_TYPES.map((tp) => ({ value: tp, label: t(`scripts.edit.canon.type_${tp}`) }))}
              onChange={({ detail }) => setNewForm((f) => ({ ...f, type: detail.selectedOption.value }))}
            />
          </CSFormField>
          <CSFormField label={t('scripts.edit.canon.field_subtype')}>
            <CSInput
              placeholder={t('script_canon.subtype_ph')}
              value={newForm.entity_subtype}
              onChange={({ detail }) => setNewForm((f) => ({ ...f, entity_subtype: detail.value }))}
            />
          </CSFormField>
          <CSFormField label={t('scripts.edit.canon.field_importance')}>
            <CSSelect
              selectedOption={IMPORTANCE_OPTIONS.find((o) => o.value === newForm.importance) || IMPORTANCE_OPTIONS[2]}
              options={IMPORTANCE_OPTIONS}
              onChange={({ detail }) => setNewForm((f) => ({ ...f, importance: detail.selectedOption.value }))}
            />
          </CSFormField>
        </CSSpaceBetween>
        <CSFormField label={t('scripts.edit.canon.field_summary')}>
          <CSInput
            placeholder={t('scripts.edit.canon.field_summary_ph')}
            value={newForm.summary}
            onChange={({ detail }) => setNewForm((f) => ({ ...f, summary: detail.value }))}
          />
        </CSFormField>
        <div style={{ marginTop: 10 }}>
          <CSSpaceBetween direction="horizontal" size="xs">
            <CSButton variant="primary" iconName="add-plus" onClick={submitAdd}>{t('scripts.edit.canon.add_confirm')}</CSButton>
            <CSButton variant="link" onClick={() => { setAdding(false); setNewForm({ logical_key: '', name: '', type: 'character', entity_subtype: '', importance: '3', summary: '' }); }}>
              {t('common.cancel')}
            </CSButton>
          </CSSpaceBetween>
        </div>
      </div>
    );
  }

  /* ---- column definitions ---- */
  const columns = [
    {
      id: 'name',
      header: t('scripts.edit.canon.col_name'),
      cell: (e) => <CellName entity={e} />,
      minWidth: 120,
      // 不设 sortingField:表格排序实际由右上角按钮按 importance 驱动(filtered useMemo),
      // 设了只会渲染一个点了没反应的死箭头(误导)。
    },
    {
      id: 'type',
      header: t('scripts.edit.canon.col_type'),
      cell: (e) => <CSBadge color={typeBadgeColor(e.type)}>{t(`scripts.edit.canon.type_${e.type}`, { defaultValue: e.type })}</CSBadge>,
      minWidth: 88,
    },
    {
      id: 'subtype',
      header: (
        // 实体在本书世界观里的功能标签(LLM 抽取时按语境生成,如 势力→宗门/军团、概念→力量体系/规则)
        <span title={t('scripts.edit.canon.col_subtype_hint', { defaultValue: '实体的功能/形态标签(如 势力→宗门、军团;概念→力量体系、规则),由 LLM 按语境生成' })}>
          {t('scripts.edit.canon.col_subtype')}
        </span>
      ),
      cell: (e) => e.entity_subtype || '—',
      minWidth: 110,
    },
    {
      id: 'parent',
      header: t('scripts.edit.canon.col_parent'),
      cell: (e) => <CellParent entity={e} />,
      minWidth: 130,
    },
    {
      id: 'importance',
      header: t('scripts.edit.canon.col_importance'),
      cell: (e) => <CellImportance entity={e} />,
      minWidth: 88,
    },
    {
      id: 'summary',
      header: t('scripts.edit.canon.col_summary'),
      // 换行显示 + 2 行截断(-webkit-line-clamp):此前 snippet(50) 硬截单行。
      // whiteSpace 必须显式 normal —— Cloudscape 单元格继承 nowrap 会让 clamp 失效成单行。
      cell: (e) => (
        <div style={{
          maxWidth: 420, fontSize: 12.5, color: 'var(--muted, #968f85)', lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere',
        }}>
          {e.summary || '—'}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: (e) => (
        <CSSpaceBetween direction="horizontal" size="xxs">
          <CSButton
            variant="inline-link"
            iconName="search"
            onClick={() => { setSelected(e); setDetailEdit({}); setSplitOpen(true); }}
          >
            {t('scripts.edit.canon.view_detail')}
          </CSButton>
          <DeleteConfirmRow entity={e} />
        </CSSpaceBetween>
      ),
    },
  ];

  /* ---- main render ---- */
  const tableEl = (
    <CSTable
      variant="container"
      loading={loading}
      loadingText={t('scripts.edit.canon.loading')}
      items={filtered}
      trackBy="logical_key"
      selectionType="single"
      selectedItems={selected ? [selected] : []}
      onSelectionChange={({ detail }) => {
        const e = detail.selectedItems[0];
        if (e) { setSelected(e); setDetailEdit({}); setSplitOpen(true); }
      }}
      columnDefinitions={columns}
      pagination={total > PAGE_SIZE ? (
        <CSPagination
          currentPageIndex={page}
          pagesCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          onChange={({ detail }) => setPage(detail.currentPageIndex)}
        />
      ) : undefined}
      header={
        <CSHeader
          variant="h2"
          counter={`(${total})`}
          actions={
            <CSSpaceBetween direction="horizontal" size="xs">
              <CSButton
                iconName={sortDesc ? 'sort-descending' : 'sort-ascending'}
                variant="icon"
                ariaLabel={t('scripts.edit.canon.sort_importance')}
                onClick={() => { setSortDesc((v) => !v); setPage(1); }}
              />
              <CSButton iconName="refresh" variant="icon" ariaLabel={t('common.refresh')} onClick={() => setReloadTick((x) => x + 1)} />
              {!readonly && (
                <CSButton iconName="add-plus" variant="primary" onClick={() => setAdding((v) => !v)}>
                  {t('scripts.edit.canon.add_btn')}
                </CSButton>
              )}
            </CSSpaceBetween>
          }
          description={t('scripts.edit.canon.description')}
        >
          {/* 类型筛选生效时标题带上类型名(如「知识库人物 · 物品」),计数即该类型条数 */}
          {t('scripts.edit.canon.title')}{typeFilter !== 'all' ? ` · ${t(`scripts.edit.canon.type_${typeFilter}`)}` : ''}
        </CSHeader>
      }
      filter={
        <CSSpaceBetween direction="horizontal" size="s">
          {renderTypeFilterControl()}
          <CSTextFilter
            filteringText={query}
            filteringPlaceholder={t('scripts.edit.canon.search_ph')}
            onChange={({ detail }) => setQuery(detail.filteringText)}
          />
        </CSSpaceBetween>
      }
      empty={
        <CSBox textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
          {query ? t('scripts.edit.canon.empty_search') : t('scripts.edit.canon.empty')}
        </CSBox>
      }
    />
  );

  return (
    <CSSpaceBetween size="m">
      {readonly && (
        <CSAlert type="info" header={t('scripts.edit.readonly_title')}>
          {t('scripts.edit.readonly_body')}
        </CSAlert>
      )}
      {adding && !readonly && <AddEntityForm />}
      <DetailDrawer
        open={splitOpen && !!selected}
        title={selected?.name || selected?.logical_key || ''}
        onClose={() => { setSelected(null); setSplitOpen(false); }}
        closeLabel={t('common.close')}
      >
        {selected && <DetailPanel entity={selected} />}
      </DetailDrawer>
      {tableEl}
    </CSSpaceBetween>
  );
}

/* ------------------------------------------------------------------ */
/* Helper: AddAliasInput                                                */
/* ------------------------------------------------------------------ */
function AddAliasInput({ onAdd }) {
  const { t } = useTranslation();
  const [val, setVal] = React.useState('');
  return (
    <CSSpaceBetween direction="horizontal" size="xs">
      <CSInput
        placeholder={t('scripts.edit.canon.alias_ph')}
        value={val}
        onChange={({ detail }) => setVal(detail.value)}
        onKeyDown={({ detail }) => { if (detail.key === 'Enter' && val.trim()) { onAdd(val.trim()); setVal(''); } }}
      />
      <CSButton
        iconName="add-plus"
        variant="icon"
        ariaLabel={t('scripts.edit.canon.alias_add')}
        disabled={!val.trim()}
        onClick={() => { onAdd(val.trim()); setVal(''); }}
      />
    </CSSpaceBetween>
  );
}

/* ------------------------------------------------------------------ */
/* Helper: badge color mapping                                          */
/* ------------------------------------------------------------------ */
function typeBadgeColor(type) {
  switch (type) {
    case 'character': return 'blue';
    case 'faction':   return 'green';
    case 'location':  return 'grey';
    case 'item':      return 'red';
    case 'concept':   return 'severity-neutral';
    default:          return 'grey';
  }
}
