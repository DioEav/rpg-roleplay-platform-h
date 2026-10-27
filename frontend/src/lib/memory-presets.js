// 记忆预设（本次优化）：让普通用户只选档位，高级用户再展开细节。
// 预设只写现有 MemorySettings 字段，不新增后端 schema；落在全局偏好或本存档
// override 上，由现有 /api/memory/settings 与 useAutoSave 持久化。
// NOTE: standard 必须与 rpg/schemas/memory.py 的 MemorySettings 默认值保持一致，
// 否则首次进入设置页（尚未保存过偏好）会把默认值显示成“自定义”。
export const MEMORY_PRESETS = {
  relaxed: {
    token_budget: 1200,
    token_estimate_factor: 1.0,
    facts_soft_limit: 60,
    summary_window: 10,
    auto_archive_after_turns: 50,
    recall_depth: 8,
  },
  standard: {
    token_budget: 1600,
    token_estimate_factor: 1.0,
    facts_soft_limit: 80,
    summary_window: 10,
    auto_archive_after_turns: 50,
    recall_depth: 8,
  },
  long: {
    token_budget: 2400,
    token_estimate_factor: 1.5,
    facts_soft_limit: 120,
    summary_window: 10,
    auto_archive_after_turns: 80,
    recall_depth: 12,
  },
};

export const MEMORY_PRESET_FIELDS = Object.keys(MEMORY_PRESETS.standard);

function _sameNumber(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) < 1e-9;
}

/** 当前值命中哪个预设；命中不了返回 "custom"。 */
export function matchMemoryPreset(values) {
  const v = values || {};
  for (const [key, preset] of Object.entries(MEMORY_PRESETS)) {
    if (MEMORY_PRESET_FIELDS.every((field) => _sameNumber(v[field], preset[field]))) {
      return key;
    }
  }
  return "custom";
}

/** 生成“把 preset 应用到当前值”的 patch；只包含预设字段。 */
export function memoryPresetPatch(presetKey) {
  const preset = MEMORY_PRESETS[presetKey];
  return preset ? { ...preset } : {};
}
