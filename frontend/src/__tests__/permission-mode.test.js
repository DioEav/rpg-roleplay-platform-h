import { describe, it, expect } from 'vitest';
import { normalizePermissionForUi } from '../lib/permission-mode.js';

describe('normalizePermissionForUi', () => {
  it('后端 auto_review / auto 归一到前端 review', () => {
    expect(normalizePermissionForUi('auto_review')).toBe('review');
    expect(normalizePermissionForUi('auto')).toBe('review');
    expect(normalizePermissionForUi('REVIEW')).toBe('review');
  });

  it('其余合法模式原样返回', () => {
    expect(normalizePermissionForUi('read_only')).toBe('read_only');
    expect(normalizePermissionForUi('default')).toBe('default');
    expect(normalizePermissionForUi('full_access')).toBe('full_access');
  });

  it('空值/未知值回退 full_access,不把 chip 打成空', () => {
    expect(normalizePermissionForUi('')).toBe('full_access');
    expect(normalizePermissionForUi(null)).toBe('full_access');
    expect(normalizePermissionForUi(undefined)).toBe('full_access');
    expect(normalizePermissionForUi('bogus')).toBe('full_access');
  });
});
