/**
 * Loom of Minds — in-chat model switch + Effort tuning. Tap to pick which model drives
 * this save's GM (save-scoped, not global), then dial its thinking budget. Effort persists
 * per-model in user preferences (model_effort dict), mirroring the desktop EffortSection.
 * A slide-up sheet of provider→model staves with a six-notch effort rail beneath.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { settings, prefs, game, ProviderInfo } from "@/api";
import { ApiError } from "@/api/http";
import { theme } from "@/theme/theme";

type ReasoningSpec = {
  supported?: boolean;
  can_disable?: boolean;
  levels?: string[];
  default_level?: string;
  confidence?: string;
};

const EFFORT_LABEL: Record<string, string> = {
  auto: "自动", off: "关", low: "低", medium: "中", high: "高", extra: "极", max: "满",
};

function realNameOf(providers: ProviderInfo[], apiId?: string, modelId?: string): string {
  if (!apiId || !modelId) return "";
  const p = providers.find((x) => (x.api_id || (x as any).id) === apiId);
  const m = (p?.models || []).find((mo: any) => (mo.real_name || mo.id) === modelId || mo.id === modelId);
  return ((m as any)?.real_name || (m as any)?.id || modelId || "") as string;
}

function reasoningOf(providers: ProviderInfo[], apiId?: string, modelId?: string): ReasoningSpec | null {
  if (!apiId || !modelId) return null;
  const p = providers.find((x) => (x.api_id || (x as any).id) === apiId);
  const m = (p?.models || []).find((mo: any) => (mo.real_name || mo.id) === modelId || mo.id === modelId);
  const r = (m as any)?.reasoning;
  return r && typeof r === "object" ? (r as ReasoningSpec) : null;
}

export function ModelEffortPicker({
  visible,
  saveId,
  onClose,
  onPicked,
}: {
  visible: boolean;
  saveId: number;
  onClose: () => void;
  onPicked?: (label: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<{ api_id?: string; model_id?: string }>({});
  const [spec, setSpec] = useState<ReasoningSpec | null>(null);
  const [effort, setEffort] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 后端偏好/思考键用的是模型 real_name;selected.model_id 是 catalog id,两者可能不同。
  const selectedReal = realNameOf(providers, selected.api_id, selected.model_id);
  // 必须用单冒号:后端偏好键是 "{api_id}:{model_id}",双冒号会写成永远读不到的孤儿键。
  const selKey = selected.api_id && selectedReal ? `${selected.api_id}:${selectedReal}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const m = await settings.models();
      const list: ProviderInfo[] = m?.models?.apis ?? [];
      for (const p of list) if (!p.api_id) p.api_id = (p as any).id;
      setProviders(list.filter((p) => p.has_credential));
      const sel = { api_id: m?.selected?.api_id, model_id: m?.selected?.model_id };
      setSelected(sel);
      setSpec(reasoningOf(list, sel.api_id, sel.model_id));
      const pr = await prefs.get().catch(() => null);
      const me = pr?.preferences?.model_effort;
      if (me && typeof me === "object") setEffort(me);
      // 本存档覆盖优先(桌面端写入的 session_reasoning 也在这里回显)。
      try {
        const st = await game.state().catch(() => null);
        const sr = st?.session_reasoning;
        const selReal = realNameOf(list, sel.api_id, sel.model_id);
        if (sel.api_id && selReal && sr
            && sr.api_id === sel.api_id && sr.model_id === selReal && sr.level) {
          setEffort((prev) => ({
            ...prev,
            [`${sel.api_id}:${selReal}`]: String(sr.level),
          }));
        }
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) Alert.alert("加载失败", e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const pick = async (api_id: string, model_id: string, label: string) => {
    setBusy(true);
    try {
      await settings.selectModel(api_id, model_id, saveId);
      setSelected({ api_id, model_id });
      setSpec(reasoningOf(providers, api_id, model_id));
      // Sync console_assistant_model_override so FamiliarSanctum follows this choice
      prefs.set({ console_assistant_model_override: { api_id, model: model_id } }).catch(() => {});
      onPicked?.(label);
    } catch (e) {
      Alert.alert("切换失败", e instanceof ApiError ? e.message : "请重试");
    } finally {
      setBusy(false);
    }
  };

  const setTier = async (tier: string) => {
    if (!selKey || !selected.api_id || !selectedReal) return;
    const next = { ...effort, [selKey]: tier };
    setEffort(next);
    try {
      if (saveId != null && saveId > 0) {
        // 本对话作用域:只影响当前存档主 GM。
        await settings.reasoning({
          api_id: selected.api_id,
          model_id: selectedReal,
          level: tier,
          save_id: saveId,
        });
      } else {
        // 无存档 → 用户级,所有对话共享。
        await prefs.set({ model_effort: next });
      }
    } catch (e) {
      // 回滚乐观更新
      setEffort((prev) => ({ ...prev, [selKey]: effort[selKey] || (spec?.default_level || "auto") }));
      Alert.alert("保存失败", e instanceof ApiError ? e.message : "请重试");
    }
  };

  const tiers = (spec?.levels || []).filter((t) => t !== "off" || spec?.can_disable);
  const rawTier = selKey ? (effort[selKey] || spec?.default_level || "auto") : "auto";
  // 旧偏好值/不支持的档位 → 就近高亮一个真实档位,避免一排全未选中。
  const currentTier = tiers.includes(rawTier)
    ? rawTier
    : (tiers.includes("high") ? "high" : (tiers[0] || "auto"));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.space(4) }]}>
        <BlurView intensity={30} tint="dark" style={styles.fill} />
        <View style={styles.grab} />
        <Text style={styles.title}>心智之织</Text>

        {loading ? (
          <ActivityIndicator color={theme.color.accent} style={{ marginVertical: theme.space(10) }} />
        ) : (
          <>
            <ScrollView style={styles.body}>
              {providers.length === 0 ? (
                <Text style={styles.empty}>没有已配置密钥的模型。请先在「设置 → 模型与密钥」添加。</Text>
              ) : (
                providers.map((p) => (
                  <View key={p.api_id} style={{ marginBottom: theme.space(3) }}>
                    <Text style={styles.provider}>{p.display_name || p.api_id}</Text>
                    {(p.models || []).slice(0, 10).map((mo: any) => {
                      const active = selected.api_id === p.api_id && selected.model_id === mo.id;
                      return (
                        <Pressable key={mo.id} onPress={() => pick(p.api_id, mo.id, mo.name || mo.id)} disabled={busy} style={[styles.modelRow, active && styles.modelActive]}>
                          <Text style={[styles.modelName, active && { color: theme.color.accentBright }]} numberOfLines={1}>{mo.name || mo.id}</Text>
                          {active ? <Text style={styles.check}>✦</Text> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ))
              )}
            </ScrollView>

            {selKey && spec?.supported && tiers.length > 1 ? (
              <View style={styles.effortWrap}>
                <Text style={styles.effortLabel}>
                  思考深度{saveId != null && saveId > 0 ? " · 本对话" : " · 所有对话"}
                </Text>
                <View style={styles.effortRail}>
                  {tiers.map((t) => {
                    const on = currentTier === t;
                    return (
                      <Pressable key={t} onPress={() => setTier(t)} style={[styles.effortNotch, on && styles.effortNotchOn]}>
                        <Text style={[styles.effortNotchText, on && { color: theme.color.bg }]}>{EFFORT_LABEL[t] || t}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.scrim },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "78%", backgroundColor: "rgba(20,16,12,0.92)", borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, borderWidth: 1, borderColor: theme.color.surfaceLineStrong, overflow: "hidden", paddingHorizontal: theme.space(5), paddingTop: theme.space(3) },
  grab: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: theme.color.surfaceLineStrong, marginBottom: theme.space(3) },
  title: { fontFamily: theme.font.display, fontSize: theme.size.lg, color: theme.color.text, letterSpacing: 1, marginBottom: theme.space(3) },
  body: { maxHeight: 360 },
  empty: { fontFamily: theme.font.proseItalic, fontSize: theme.size.md, color: theme.color.textFaint, textAlign: "center", paddingVertical: theme.space(10), lineHeight: 22 },
  provider: { fontFamily: theme.font.displaySemi, fontSize: theme.size.xs, letterSpacing: 2, textTransform: "uppercase", color: theme.color.accent, marginBottom: theme.space(2) },
  modelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.space(2.5), paddingHorizontal: theme.space(3), borderRadius: theme.radius.sm },
  modelActive: { backgroundColor: theme.color.accentGhost },
  modelName: { flex: 1, fontFamily: theme.font.mono, fontSize: theme.size.sm, color: theme.color.textDim },
  check: { color: theme.color.accentBright, fontSize: theme.size.md },
  effortWrap: { paddingTop: theme.space(3), borderTopWidth: 1, borderTopColor: theme.color.surfaceLine, gap: theme.space(2) },
  effortLabel: { fontFamily: theme.font.displaySemi, fontSize: theme.size.xs, letterSpacing: 2, textTransform: "uppercase", color: theme.color.textFaint },
  effortRail: { flexDirection: "row", gap: theme.space(2) },
  effortNotch: { flex: 1, paddingVertical: theme.space(2.5), alignItems: "center", borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.color.surfaceLine, backgroundColor: theme.color.bgCard },
  effortNotchOn: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  effortNotchText: { fontFamily: theme.font.displaySemi, fontSize: theme.size.base, color: theme.color.textDim },
});
