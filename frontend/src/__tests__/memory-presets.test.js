// 记忆预设（本轮优化）：三档预设的匹配/补丁逻辑回归。
// 纯函数测试，不渲染组件；后端字段校验在 rpg/tests/unit/test_memory_lifecycle_assembler.py。
import { describe, expect, it } from "vitest";
import {
  MEMORY_PRESETS,
  MEMORY_PRESET_FIELDS,
  matchMemoryPreset,
  memoryPresetPatch,
} from "../lib/memory-presets.js";

describe("memory presets", () => {
  it("每档预设都能被精确识别", () => {
    for (const [key, preset] of Object.entries(MEMORY_PRESETS)) {
      expect(matchMemoryPreset({ ...preset })).toBe(key);
    }
  });

  it("接口返回的数值字符串也能识别（避免 JSON/表单把数字变字符串）", () => {
    const asStrings = Object.fromEntries(
      Object.entries(MEMORY_PRESETS.long).map(([k, v]) => [k, String(v)]),
    );
    expect(matchMemoryPreset(asStrings)).toBe("long");
  });

  it("任一字段偏离预设即视为自定义", () => {
    expect(matchMemoryPreset({ ...MEMORY_PRESETS.standard, token_budget: 1601 }))
      .toBe("custom");
    expect(matchMemoryPreset({})).toBe("custom");
  });

  it("补丁只包含预设字段且返回新对象", () => {
    const patch = memoryPresetPatch("relaxed");
    expect(Object.keys(patch).sort()).toEqual([...MEMORY_PRESET_FIELDS].sort());
    expect(patch).not.toBe(MEMORY_PRESETS.relaxed);
    patch.token_budget = 1;
    expect(MEMORY_PRESETS.relaxed.token_budget).toBe(1200);
    expect(memoryPresetPatch("nope")).toEqual({});
  });
});
