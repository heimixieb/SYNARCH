import { useEffect, useState } from "react";
import { configuredModelInstances } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { modelName, providerName } from "@/lib/simple-model-menu";
import { api } from "@/state/api";
import { useStore } from "@/state/store";

type Settings = { checkGoals: boolean; tags: Record<string, string> };

/** SYNARCH: the chief's routing switches, and what each model is good at (the same tags the chief saves with tag_model). */
export function ChiefRoutingSettings({ name }: { name: string }) {
  const { state } = useStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [picked, setPicked] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Settings>("/api/synarch/settings").then(setSettings).catch(() => setError(t("chiefRouting.loadFailed")));
  }, []);

  const models = configuredModelInstances(state.instances).flatMap(instance => instance.models.options.map(option => ({
    key: `${instance.instanceId}/${option.id}`, instanceId: instance.instanceId, model: option.id,
    label: `${providerName(instance)} · ${modelName(instance, option.id)}`,
  })));
  const labelOf = (key: string) => models.find(model => model.key === key)?.label ?? key;
  const choice = models.find(model => model.key === picked);

  const saveTags = async (instanceId: string, model: string, tags: string) => {
    setError("");
    try {
      const saved = await api<{ tags: Record<string, string> }>("/api/synarch/model-tags", { method: "POST", body: JSON.stringify({ instanceId, model, tags }) });
      setSettings(current => current && { ...current, tags: saved.tags });
    } catch {
      setError(t("chiefRouting.saveFailed"));
    }
  };
  const toggleChecks = async (checkGoals: boolean) => {
    setError("");
    try {
      const saved = await api<Omit<Settings, "tags">>("/api/synarch/settings", { method: "POST", body: JSON.stringify({ checkGoals }) });
      setSettings(current => current && { ...current, ...saved });
    } catch {
      setError(t("chiefRouting.saveFailed"));
    }
  };

  const tagged = Object.entries(settings?.tags ?? {});
  return (
    <details>
      <summary className="cursor-pointer text-[13px] font-medium text-ink">{t("chiefRouting.title")}</summary>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("chiefRouting.description", { name })}</p>
      {settings && <>
        <label className="mt-3 flex items-start gap-2 text-[13px] text-ink">
          <input type="checkbox" className="mt-0.5 accent-accent" checked={settings.checkGoals}
            onChange={event => void toggleChecks(event.target.checked)} />
          <span>
            <span className="font-medium">{t("chiefRouting.checkGoals")}</span>
            <span className="block text-ink-secondary">{t("chiefRouting.checkGoalsHint")}</span>
          </span>
        </label>
        <div className="mt-3 flex flex-col gap-2 border-t border-hairline/40 pt-3">
          <select aria-label={t("chiefRouting.model")} value={picked}
            onChange={event => { setPicked(event.target.value); setDraft(settings.tags[event.target.value] ?? ""); }}
            className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[13px] text-ink">
            <option value="">{t("chiefRouting.pick")}</option>
            {models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}
          </select>
          {choice && <>
            <textarea value={draft} maxLength={200} rows={2} placeholder={t("chiefRouting.tagsPlaceholder")}
              onChange={event => setDraft(event.target.value)}
              className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[13px] text-ink" />
            <button type="button" disabled={draft.trim() === (settings.tags[choice.key] ?? "")}
              onClick={() => void saveTags(choice.instanceId, choice.model, draft)}
              className="self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">
              {t("chiefRouting.save")}
            </button>
          </>}
        </div>
        <p className="mt-3 text-[13px] font-medium text-ink">{t("chiefRouting.saved")}</p>
        {tagged.length ? <ul className="mt-1 flex flex-col gap-1">
          {tagged.map(([key, tags]) => {
            const slash = key.indexOf("/");
            return (
              <li key={key} className="flex items-start justify-between gap-2 text-[13px]">
                <span><span className="font-medium text-ink">{labelOf(key)}</span><span className="text-ink-secondary">: {tags}</span></span>
                <button type="button" className="shrink-0 text-ink-secondary hover:text-ink"
                  onClick={() => void saveTags(key.slice(0, slash), key.slice(slash + 1), "")}>
                  {t("chiefRouting.remove")}
                </button>
              </li>
            );
          })}
        </ul> : <p className="mt-1 text-[13px] text-ink-secondary">{t("chiefRouting.none")}</p>}
      </>}
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    </details>
  );
}
