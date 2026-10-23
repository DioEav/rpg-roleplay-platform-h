// 供应商配置区(10 家 provider 卡片:API Key / Base URL 中转站 / SA JSON / DashScope mode)。
// 从 components/settings/models-section.jsx 二次拆分,纯机械搬家,逐字节不动。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import { SetGroup } from './shared.jsx';
import { normalizeApiId, catalogApiIdForCredential, PROVIDERS_CONFIG } from './models-catalog.js';
import CSContainer from '@cloudscape-design/components/container';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSAlert from '@cloudscape-design/components/alert';
import CSBox from '@cloudscape-design/components/box';
import CSButton from '@cloudscape-design/components/button';
import CSFormField from '@cloudscape-design/components/form-field';
import CSInput from '@cloudscape-design/components/input';
import CSSelect from '@cloudscape-design/components/select';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';


/**
 * Wave 11-C: 10 provider 配置卡片
 * 每家 provider 独立一卡:API Key 输入 + base_url 可改(中转站)
 * Agent Platform:JSON 文件上传, 解析验证字段后 POST credentials.set
 * 阿里 DashScope:mode toggle (OpenAI-compat vs native)
 */
function ProviderConfigSection() {
  const { t } = useTranslation();
  const isAdminUser = !!(window.RPG_AUTH && window.RPG_AUTH.authed && window.MOCK_PLATFORM?.user?.role === "admin");
  const [creds, setCreds] = useStatePL({});
  const [saving, setSaving] = useStatePL({});
  const [agentPlatformJson, setAgentPlatformJson] = useStatePL(null);
  const [agentPlatformError, setAgentPlatformError] = useStatePL("");
  const [alibabaMode, setAlibabaMode] = useStatePL("openai_compat");

  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.credentials.list().catch(() => ({ items: [] }));
        if (cancelled) return;
        const map = {};
        for (const c of (r?.items || r?.credentials || [])) {
          const pid = normalizeApiId(c.api_id || c.id);
          map[pid] = { has_key: !!c.has_credential || !!c.has_key, key_hint: c.key_hint || "", base_url: c.base_url_override || "", api_format: c.api_format || "", auth_mode: c.auth_mode || "api_key" };
        }
        setCreds(map);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const saveKey = async (providerId, apiKey, baseUrl, apiFormat) => {
    setSaving(s => ({ ...s, [providerId]: true }));
    try {
      const existing = creds[providerId] || {};
      const formatChanged = !!apiFormat && apiFormat !== (existing.api_format || "chat_completions");
      if (apiKey && apiKey.trim()) {
        await window.api.credentials.set({
          api_id: providerId, api_key: apiKey.trim(),
          ...(apiFormat ? { api_format: apiFormat } : {}),
        });
      } else if (formatChanged) {
        // 只切换格式：不重填 key，避免空 key 触发删除语义。
        await window.api.credentials.set({
          api_id: providerId, api_key: '',
          base_url_override: existing.base_url || undefined,
          keep_key: true, api_format: apiFormat,
        });
      }
      if (baseUrl !== undefined) {
        if (isAdminUser) {
          const cfg = PROVIDERS_CONFIG.find((p) => p.id === providerId);
          const kind = providerId === "AgentPlatform" ? "vertex_ai" : providerId === "anthropic" ? "anthropic" : "openai_compat";
          await window.api.models.upsertApi({
            api_id: catalogApiIdForCredential(providerId), base_url: baseUrl, kind,
            display_name: cfg?.name || providerId,
            ...(apiFormat ? { api_format: apiFormat } : {}),
          });
        } else {
          window.__apiToast?.(t('settings_extra.admin_base_url_only'), { kind: "warn", duration: 3000 });
        }
      }
      window.__apiToast?.(t('settings.providers.save_ok'), { kind: "ok", duration: 1800 });
      setCreds(s => ({ ...s, [providerId]: { ...s[providerId], has_key: !!(apiKey?.trim() || s[providerId]?.has_key), base_url: baseUrl ?? s[providerId]?.base_url, api_format: apiFormat ?? s[providerId]?.api_format } }));
    } catch (e) {
      window.__apiToast?.(t('settings.providers.save_fail'), { kind: "danger", detail: e?.message });
    } finally {
      setSaving(s => ({ ...s, [providerId]: false }));
    }
  };

  const handleAgentPlatformFile = async (file) => {
    setAgentPlatformError("");
    setAgentPlatformJson(null);
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const missing = ["client_email", "private_key", "project_id"].filter(k => !json[k]);
      if (missing.length > 0) {
        setAgentPlatformError(`JSON missing required fields: ${missing.join(", ")}`);
        return;
      }
      setAgentPlatformJson(json);
    } catch (e) {
      setAgentPlatformError("JSON parse error: " + (e?.message || "unknown"));
    }
  };

  const saveAgentPlatform = async () => {
    if (!agentPlatformJson) return;
    setSaving(s => ({ ...s, AgentPlatform: true }));
    try {
      await window.api.credentials.set({
        api_id: "AgentPlatform",
        api_key: JSON.stringify(agentPlatformJson),
      });
      window.__apiToast?.(t('settings.providers.save_cred_ok'), { kind: "ok", duration: 2000 });
      setCreds(s => ({ ...s, AgentPlatform: { ...s.AgentPlatform, has_key: true } }));
      setAgentPlatformJson(null);
    } catch (e) {
      window.__apiToast?.(t('settings.providers.save_fail'), { kind: "danger", detail: e?.message });
    } finally {
      setSaving(s => ({ ...s, AgentPlatform: false }));
    }
  };

  return (
    <SetGroup
      title={t('settings.providers.title')}
      description={t('settings.providers.description')}
      data-cap-anchor="settings.providers"
    >
      <CSSpaceBetween size="m">
        {PROVIDERS_CONFIG.filter(p => !p.deprecated || creds[p.id]?.has_key).map(p => {
          const cred = creds[p.id] || {};
          const isSaving = !!saving[p.id];
          return (
            <ProviderCard
              key={p.id}
              provider={p}
              cred={cred}
              isSaving={isSaving}
              agentPlatformJson={agentPlatformJson}
              agentPlatformError={agentPlatformError}
              alibabaMode={alibabaMode}
              onSaveKey={saveKey}
              onAgentPlatformFile={handleAgentPlatformFile}
              onSaveAgentPlatform={saveAgentPlatform}
              onAlibabaMode={(v) => { setAlibabaMode(v); window.api.models.upsertApi({ api_id: "dashscope", kind: "openai_compat", base_url: v === "openai_compat" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://dashscope.aliyuncs.com/api/v1" }).catch(() => {}); }}
            />
          );
        })}
      </CSSpaceBetween>
    </SetGroup>
  );
}

function ProviderCard({ provider: p, cred, isSaving, agentPlatformJson, agentPlatformError, alibabaMode, onSaveKey, onAgentPlatformFile, onSaveAgentPlatform, onAlibabaMode }) {
  const { t } = useTranslation();
  const [keyVal, setKeyVal] = useStatePL("");
  const [baseVal, setBaseVal] = useStatePL(cred.base_url || p.defaultBase || "");
  const [fmtVal, setFmtVal] = useStatePL(cred.api_format || "chat_completions");
  useEffectPL(() => { setBaseVal(cred.base_url || p.defaultBase || ""); }, [cred.base_url, p.defaultBase]);
  useEffectPL(() => { setFmtVal(cred.api_format || "chat_completions"); }, [cred.api_format]);
  // Anthropic 走原生协议，不暴露 OpenAI 家族的 Chat/Responses 选择。
  const supportsFormat = p.id !== "anthropic" && p.special !== "agent_platform";
  const formatOptions = [
    { value: "chat_completions", label: t('settings.edit_api.api_format_chat') },
    { value: "responses", label: t('settings.edit_api.api_format_responses') },
  ];

  // Agent Platform 走专用 UI
  if (p.special === "agent_platform") {
    return (
      <CSContainer>
        <CSSpaceBetween size="s">
          {p.unavailable && (
            <CSAlert type="warning" header={t('settings.providers.sa.unavailable_title')}>
              {t('settings.providers.sa.unavailable_desc')}
            </CSAlert>
          )}
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
            <div>
              <CSBox fontWeight="bold">{p.name}</CSBox>
              <CSBox color="text-body-secondary" fontSize="body-s">{p.noteKey ? t(p.noteKey) : p.note}</CSBox>
            </div>
            {cred.has_key && <CSStatusIndicator type="success">{t('settings.providers.configured')}</CSStatusIndicator>}
          </CSSpaceBetween>
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
            <label className="btn ghost" style={{cursor: "pointer", position: "relative"}}>
              <Icon name="upload" size={12} /> {t('settings.providers.select_json')}
              <input
                type="file"
                accept="application/json,.json"
                style={{position: "absolute", opacity: 0, width: 0, height: 0}}
                onChange={(e) => onAgentPlatformFile(e.target.files?.[0] || null)}
              />
            </label>
            {agentPlatformJson && (
              <CSBox color="text-status-success" fontSize="body-s">
                <Icon name="check" size={11} /> {agentPlatformJson.client_email}
              </CSBox>
            )}
          </CSSpaceBetween>
          {agentPlatformError && (
            <CSAlert type="error">{agentPlatformError}</CSAlert>
          )}
          {agentPlatformJson && !agentPlatformError && (
            <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
              <CSBox color="text-body-secondary" fontSize="body-s">
                project_id: <span className="mono">{agentPlatformJson.project_id}</span>
              </CSBox>
              <CSButton variant="primary" loading={isSaving} disabled={isSaving} onClick={onSaveAgentPlatform}>
                {t('settings.providers.save_cred')}
              </CSButton>
            </CSSpaceBetween>
          )}
        </CSSpaceBetween>
      </CSContainer>
    );
  }

  // 阿里 DashScope 带 mode toggle
  if (p.special === "alibaba_qwen") {
    return (
      <CSContainer>
        <CSSpaceBetween size="s">
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
            <div>
              <CSBox fontWeight="bold">{p.name}</CSBox>
              <CSBox color="text-body-secondary" fontSize="body-s">{p.noteKey ? t(p.noteKey) : p.note}</CSBox>
            </div>
            {cred.has_key && <CSStatusIndicator type="success">{t('settings.providers.configured')}</CSStatusIndicator>}
          </CSSpaceBetween>
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
            <div className="seg" style={{display: "flex"}}>
              <button className={alibabaMode === "openai_compat" ? "active" : ""} onClick={() => onAlibabaMode("openai_compat")}>OpenAI-compat</button>
              <button className={alibabaMode === "native" ? "active" : ""} onClick={() => onAlibabaMode("native")}>Native DashScope</button>
            </div>
            <CSBox color="text-status-inactive" fontSize="body-s">
              <span className="mono">{alibabaMode === "openai_compat" ? "/compatible-mode/v1" : "/api/v1"}</span>
            </CSBox>
          </CSSpaceBetween>
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="flex-end">
            <CSFormField label={t('settings.edit_api.api_key')} stretch>
              <CSInput
                type="password"
                value={keyVal}
                onChange={({ detail }) => setKeyVal(detail.value)}
                placeholder={cred.has_key ? t('settings.providers.keep_key') : "sk-…"}
                autoComplete="new-password"
              />
            </CSFormField>
            <CSButton
              variant="primary"
              loading={isSaving}
              disabled={isSaving || (!keyVal.trim() && !baseVal)}
              onClick={() => onSaveKey(p.id, keyVal, baseVal)}
            >
              {t('common.save')}
            </CSButton>
          </CSSpaceBetween>
        </CSSpaceBetween>
      </CSContainer>
    );
  }

  // OpenRouter 带 base_url hint（及其它普通 provider）
  return (
    <CSContainer>
      <CSSpaceBetween size="s">
        {p.deprecated && (
          <CSAlert key="deprecated" type="warning" header={t('settings.providers.deprecated_geo_title')}>
            {t('settings.providers.deprecated_geo_desc')}
          </CSAlert>
        )}
        <CSSpaceBetween key="hdr" direction="horizontal" size="xs" alignItems="center">
          <div>
            <CSBox fontWeight="bold">{p.name}</CSBox>
            {(p.note || p.noteKey) && <CSBox color="text-body-secondary" fontSize="body-s">{p.noteKey ? t(p.noteKey) : p.note}</CSBox>}
          </div>
          {cred.has_key && <CSStatusIndicator type="success">{t('settings.providers.configured')}</CSStatusIndicator>}
        </CSSpaceBetween>
        <CSSpaceBetween key="form" direction="horizontal" size="xs" alignItems="flex-end">
          <CSFormField label={t('settings.edit_api.api_key')} stretch>
            <CSInput
              type="password"
              value={keyVal}
              onChange={({ detail }) => setKeyVal(detail.value)}
              placeholder={cred.has_key ? t('settings.providers.keep_key') : (p.keyEnv ? p.keyEnv : "sk-…")}
              autoComplete="new-password"
            />
          </CSFormField>
          <CSFormField
            label={p.special === "openrouter" ? t('settings.providers.base_url_relay') : t('settings.providers.base_url')}
            stretch
          >
            <CSInput
              value={baseVal}
              onChange={({ detail }) => setBaseVal(detail.value)}
              placeholder={p.defaultBase || "https://…"}
            />
          </CSFormField>
          {supportsFormat && (
            <CSFormField label={t('settings.edit_api.api_format')} stretch>
              <CSSelect
                selectedOption={formatOptions.find((o) => o.value === fmtVal) || formatOptions[0]}
                options={formatOptions}
                onChange={({ detail }) => setFmtVal(detail.selectedOption.value)}
              />
            </CSFormField>
          )}
          <CSButton
            variant="primary"
            loading={isSaving}
            disabled={isSaving || (!keyVal.trim()
              && baseVal === (cred.base_url || p.defaultBase || "")
              && (!supportsFormat || fmtVal === (cred.api_format || "chat_completions")))}
            onClick={() => onSaveKey(p.id, keyVal, baseVal, supportsFormat ? fmtVal : undefined)}
          >
            {t('common.save')}
          </CSButton>
        </CSSpaceBetween>
      </CSSpaceBetween>
    </CSContainer>
  );
}

export { ProviderConfigSection, ProviderCard };
