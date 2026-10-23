// 设置页共享 primitives(SetGroup / SetRow / SetSelect)。纯机械从 pages/settings.jsx 搬出,零行为变化。
import React from 'react';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSFormField from '@cloudscape-design/components/form-field';
import CSSelect from '@cloudscape-design/components/select';

/* ── 设置页 Cloudscape 统一 primitives(取代 pl-set-group / pl-set-row) ──
   SetGroup = Container + Header(h2)  ·  SetRow = FormField(label 上 / 控件下)。
   各 section 用这两个套,保证全站基线对齐、间距一致。 */
function SetGroup({ title, description, actions, children }) {
  // 用 Header 原生 description 渲染 section 说明(可见副标题、原生预留间隔),
  // 不再塞进标题旁 ⓘ —— 短说明直接展示更易读,也让各 section 基线一致。
  return (
    <CSContainer header={<CSHeader variant="h2" actions={actions} description={description || undefined}>{title}</CSHeader>}>
      {/* React.Children.toArray 给多子元素派稳定 key,避免 SpaceBetween 的 key 警告 */}
      <CSSpaceBetween size="l">{React.Children.toArray(children)}</CSSpaceBetween>
    </CSContainer>
  );
}
function SetRow({ label, description, children }) {
  // 用 FormField 原生 description(label 下方可见副标题):短帮助文字直接显示而非藏进 ⓘ,
  // FormField 自带副标题预留间隔 → 行结构一致、并排字段组控件纵向对齐。
  return (
    <CSFormField label={label} description={description || undefined}>
      {children}
    </CSFormField>
  );
}
/* 简单 <select> → CSSelect 适配:options 为 [{value,label}]
   expandToViewport:弹窗 / 滚动容器内使用,下拉浮层挂到 body,避免被 overflow 裁切。 */
function SetSelect({ value, options, onChange, disabled, expandToViewport, ariaLabel }) {
  const sel = options.find((o) => o.value === value) || null;
  return (
    <CSSelect
      selectedOption={sel}
      options={options}
      disabled={disabled}
      expandToViewport={expandToViewport}
      ariaLabel={ariaLabel}
      onChange={({ detail }) => onChange(detail.selectedOption.value)}
    />
  );
}

export {
  SetGroup,
  SetRow,
  SetSelect,
};
