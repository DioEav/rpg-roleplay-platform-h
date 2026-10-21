/* TablePagination — 通用表格分页条(数据范围/总数 + 每页条数选择 + 页码切换)。
   供分页列表页复用(角色卡/身份卡/存档/剧本等):纯受控组件,total/page/pageSize 进、
   onPageChange/onPageSizeChange 回调出,数据获取由调用方负责(服务端或客户端分页均可)。
   布局 = 两端式:左信息簇(总数 · 范围 · 条数选择)| 右页码窗,顶部发丝线作页脚分隔。
   样式在 platform.css 的 .pl-tbp 命名空间。
   用法:直接传给 Cloudscape 表格的 pagination 槽,或独立放在列表下方。 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../game-icons.jsx';
// 与偏好界面 SetSelect 同款组件(偏好/设置全站基线),圆角/悬停/下拉面板观感自动一致;
// expandToViewport 防止面板被表格容器的 overflow 裁剪。
import CSSelect from '@cloudscape-design/components/select';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/* 页码窗口:首末页恒显,当前页 ±1,其余以省略号折叠(总页数 ≤7 全量平铺) */
function pageWindow(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const items = [1];
  if (page > 3) items.push('…');
  for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) items.push(i);
  if (page < pageCount - 2) items.push('…');
  items.push(pageCount);
  return items;
}

function TablePagination({
  total,                    // 总条数(展示"共 N 条"/数据范围、计算页数)
  page,                     // 当前页(1 起)
  pageSize,                 // 每页条数(受控)
  onPageChange,             // (nextPage) => void
  onPageSizeChange,         // (nextSize) => void;调用方应自行回到第 1 页
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
}) {
  const { t } = useTranslation();
  const pageCount = Math.max(1, Math.ceil((total || 0) / (pageSize || 1)));
  const cur = Math.min(Math.max(1, page || 1), pageCount);
  const from = total > 0 ? (cur - 1) * pageSize + 1 : 0;
  const to = Math.min(cur * pageSize, total || 0);
  return (
    <div className="pl-tbp">
      {/* 左:信息簇(总数 · 当前范围 · 每页条数) */}
      <div className="pl-tbp-left">
        <span className="pl-tbp-total">
          {t('common.pagination.total', { n: total || 0, defaultValue: `共 ${total || 0} 条` })}
        </span>
        {total > 0 && (
          <>
            <span className="pl-tbp-div" aria-hidden="true" />
            <span className="pl-tbp-range">
              {t('common.pagination.range', { from, to, defaultValue: `第 ${from}–${to} 条` })}
            </span>
          </>
        )}
        <span className="pl-tbp-div" aria-hidden="true" />
        <label className="pl-tbp-size">
          {t('common.pagination.per_page', { defaultValue: '每页' })}
          {/* 下拉 = 偏好界面同款 Cloudscape CSSelect(组件级一致,圆角/悬停/面板样式不再手搓) */}
          <span className="pl-tbp-select-wrap">
            <CSSelect
              selectedOption={{ value: String(pageSize), label: String(pageSize) }}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
              expandToViewport
              onChange={({ detail }) => onPageSizeChange(Number(detail.selectedOption.value))}
            />
          </span>
          {t('common.pagination.unit', { defaultValue: '条' })}
        </label>
      </div>
      {/* 右:页码窗 */}
      <nav className="pl-tbp-nav" aria-label={t('common.pagination.nav_label', { defaultValue: '分页' })}>
        <button type="button" className="pl-tbp-btn bordered" disabled={cur <= 1}
          aria-label={t('common.pagination.prev', { defaultValue: '上一页' })}
          onClick={() => onPageChange(cur - 1)}>
          <Icon name="chevron_left" size={13} />
        </button>
        {pageWindow(cur, pageCount).map((it, idx) => it === '…' ? (
          <span key={`dots${idx}`} className="pl-tbp-dots" aria-hidden="true">…</span>
        ) : (
          <button type="button" key={it} className={`pl-tbp-btn${it === cur ? ' on' : ''}`}
            aria-current={it === cur ? 'page' : undefined}
            aria-label={t('common.pagination.page_n', { n: it, defaultValue: `第 ${it} 页` })}
            onClick={() => { if (it !== cur) onPageChange(it); }}>
            {it}
          </button>
        ))}
        <button type="button" className="pl-tbp-btn bordered" disabled={cur >= pageCount}
          aria-label={t('common.pagination.next', { defaultValue: '下一页' })}
          onClick={() => onPageChange(cur + 1)}>
          <Icon name="chevron_right" size={13} />
        </button>
      </nav>
    </div>
  );
}

export default TablePagination;
export { TablePagination };
