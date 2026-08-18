import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DeviceScaleKey,
  GeneratorConfig,
  GenerationStats,
  Optimization,
  JsonExportMode,
} from "./lib/types";
import {
  HTML_LANGS,
  LANG_NAMES,
  MILIASTRA_LANGS,
  SHARED_LANG_KEY,
  isValidLang,
  resolveLang,
  saveLang,
  translate,
  type Lang,
  type MessageKey,
} from "./lib/i18n";
import type { WorkerRequest, WorkerResponse } from "./workers/generator.worker";

const DEFAULT_CONFIG: GeneratorConfig = {
  optimization: "safe-overdraw",
  pixelSize: 10,
  imageRotation: 0,
  parentName: "Shapes",
  parentX: 0,
  parentY: 0,
  fieldScale: 0.5,
  deviceScales: {
    desktop: 1,
    mobile: 1,
    controller: 1,
    mobileController: 1,
  },
  keepParentPosition: false,
  yDown: false,
  exportLayerOrder: "front-to-back",
  maxMergePasses: 200,
  maxOverdrawRatio: 2.5,
  safeTimeSeconds: 10,
  underpaintMaxBBoxRatio: 6,
  underpaintMinComponentPixels: 8,
  underpaintMinSavings: 2,
  underpaintBeamWidth: 64,
  underpaintBeamCandidates: 256,
  stage1Passes: 1200,
  stage1Ratio: 3,
  stage2Passes: 2000,
  stage2Ratio: 10,
};

const DEVICE_SCALE_FIELDS: Array<{ key: DeviceScaleKey; labelKey: MessageKey }> = [
  { key: "desktop", labelKey: "deviceDesktop" },
  { key: "mobile", labelKey: "deviceMobile" },
  { key: "controller", labelKey: "deviceController" },
  { key: "mobileController", labelKey: "deviceMobileController" },
];

// Known worker progress strings mapped to translation keys; anything else
// (e.g. optimizer pass counters) is shown verbatim.
const WORKER_PROGRESS_KEYS: Record<string, MessageKey> = {
  "Loading schema and template": "statusLoadingSchema",
  "Optimizing rectangles": "statusOptimizing",
  "Encoding .gia file": "statusEncoding",
};

// Status is stored as a key + params (or a raw string) so it re-renders in
// the right language when the user switches mid-run.
type StatusMessage =
  | { key: MessageKey; params?: Record<string, string | number> }
  | { raw: string };

function numberValue(value: string, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parentNameFromFile(file: File) {
  return file.name.replace(/\.[^.]+$/, "") || "Shapes";
}

async function fileToImageData(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create 2D context");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const [lang, setLang] = useState<Lang>(() => resolveLang());
  const [config, setConfig] = useState<GeneratorConfig>(DEFAULT_CONFIG);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [status, setStatus] = useState<StatusMessage>({ key: "statusChoosePng" });
  const [busy, setBusy] = useState(false);
  const [downloadBlob, setDownloadBlob] = useState<Blob | null>(null);
  const [downloadName, setDownloadName] = useState<string>("output.gia");
  const [stats, setStats] = useState<GenerationStats | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonMode, setJsonMode] = useState<JsonExportMode>("raw");
  const [lastJson, setLastJson] = useState<{ blob: Blob; name: string } | null>(null);


  const t = useMemo(
    () =>
      (key: MessageKey, params?: Record<string, string | number>) =>
        translate(lang, key, params),
    [lang]
  );

  useEffect(() => {
    document.documentElement.lang = HTML_LANGS[lang];
    document.title = translate(lang, "appEyebrow");
  }, [lang]);

  // Live cross-site sync: a language picked on another toolkit tab updates
  // this one. Must not write back to localStorage (see docs/language-sync.md).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SHARED_LANG_KEY && e.newValue && isValidLang(e.newValue)) {
        setLang(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const worker = new Worker(
      new URL("./workers/generator.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        const key = WORKER_PROGRESS_KEYS[msg.message];
        setStatus(key ? { key } : { raw: msg.message });
      } else if (msg.type === "gia-done") {
        const blob = new Blob([msg.giaBytes], {
          type: "application/octet-stream",
        });
        setDownloadBlob(blob);
        setDownloadName(msg.downloadName);
        setStats(msg.stats);
        setStatus({ key: "statusDone", params: { count: msg.stats.shapeCount } });
        setBusy(false);
      } else if (msg.type === "json-done") {
        const blob = new Blob([msg.json], { type: "application/json" });
        setLastJson({ blob, name: msg.downloadName });
        setStats(msg.stats);
        downloadFile(blob, msg.downloadName);
        setStatus({
          raw: `Done. ${msg.stats.shapeCount} shapes generated; JSON downloaded.`,
        });
        setBusy(false);
      } else if (msg.type === "error") {
        setStatus({ key: "statusError", params: { message: msg.error } });
        setBusy(false);
      }
    };
    return () => {
      worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const canGenerate = !!file && !busy;
  const canDownload = !!downloadBlob && !busy;

  const statusText = "raw" in status ? status.raw : t(status.key, status.params);

  const canExportJson = !!file && !busy;
  const summary = useMemo(() => {
    if (!stats) return t("noExport");
    return t("summaryLine", {
      width: stats.width,
      height: stats.height,
      count: stats.shapeCount,
      seconds: (stats.elapsedMs / 1000).toFixed(2),
    });
  }, [stats, t]);

  const maxPreviewScale = useMemo(() => {
    return Math.max(
      0.01,
      ...DEVICE_SCALE_FIELDS.map(({ key }) => config.deviceScales[key])
    );
  }, [config.deviceScales]);

  const previewPixelScale = useMemo(() => {
    return Math.max(0.05, config.pixelSize / 10);
  }, [config.pixelSize]);

  const previewRotationFit = useMemo(() => {
    const radians = (Math.abs(config.imageRotation) % 180) * (Math.PI / 180);
    const rotatedBoundsMultiplier =
      Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians));

    return 1 / Math.max(1, rotatedBoundsMultiplier);
  }, [config.imageRotation]);

  function handleLangChange(code: Lang) {
    setLang(code);
    saveLang(code);
  }

  async function handleGenerate() {
    if (!file || !workerRef.current) return;
    setBusy(true);
    setStats(null);
    setDownloadBlob(null);
    setStatus({ key: "statusReadingPng" });

    try {
      const imageData = await fileToImageData(file);
      const payload: WorkerRequest = {
        imageData,
        config,
        assetBase: new URL("./", window.location.href).href,
        fileName: file.name,
        output: "gia",
      };
      workerRef.current.postMessage(payload);
    } catch (error) {
      setStatus({
        key: "statusError",
        params: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      setBusy(false);
    }
  }

  function update<K extends keyof GeneratorConfig>(
    key: K,
    value: GeneratorConfig[K]
  ) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateDeviceScale(key: DeviceScaleKey, value: number) {
    setConfig((prev) => ({
      ...prev,
      deviceScales: {
        ...prev.deviceScales,
        [key]: value,
      },
    }));
  }

  function handleImageChange(nextFile: File | null) {
    setFile(nextFile);
    setDownloadBlob(null);
    setStats(null);
    setLastJson(null);

    if (nextFile) {
      const nextParentName = parentNameFromFile(nextFile);
      setConfig((prev) => ({ ...prev, parentName: nextParentName }));
      setStatus({
        key: "statusLoaded",
        params: { file: nextFile.name, name: nextParentName },
      });
    } else {
      setConfig((prev) => ({ ...prev, parentName: DEFAULT_CONFIG.parentName }));
      setStatus({ key: "statusChoosePng" });
    }
  }

  function handleDownload() {
    if (!downloadBlob) return;
    downloadFile(downloadBlob, downloadName);
  }

  async function handleJsonExport() {
    if (!file || !workerRef.current) return;
    setBusy(true);
    setStats(null);
    setLastJson(null);
    setStatus({ key: "statusReadingPng" });
    try {
      const imageData = await fileToImageData(file);
      const payload: WorkerRequest = {
        imageData,
        config,
        assetBase: new URL("./", window.location.href).href,
        fileName: file.name,
        output: "json",
        jsonMode,
      };
      workerRef.current.postMessage(payload);
    } catch (error) {
      setStatus({
        key: "statusError",
        params: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      setBusy(false);
    }
  }

  function handleViewJson() {
    if (!lastJson) return;
    const url = URL.createObjectURL(lastJson.blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div className="shell">
      <div className="backdrop" />
      <main className="app-card">
        <section className="left-pane">
          <div className="title-block">
            <div className="title-row">
              <p className="eyebrow">{t("appEyebrow")}</p>
              <select
                className="lang-select"
                aria-label={t("languageLabel")}
                value={lang}
                onChange={(e) => handleLangChange(e.target.value as Lang)}
              >
                {MILIASTRA_LANGS.map((code) => (
                  <option key={code} value={code}>
                    {LANG_NAMES[code]}
                  </option>
                ))}
              </select>
            </div>
            <h1>PNG → .gia</h1>
            <p className="subtitle">{t("appSubtitle")}</p>
          </div>

          <h2 className="section-title">{t("sectionConversion")}</h2>
          <div className="control-grid">
            <label className="field field-file">
              <span>{t("fieldImage")}</span>
              <input
                type="file"
                accept="image/png"
                onChange={(e) => handleImageChange(e.target.files?.[0] ?? null)}
              />
            </label>

            <label className="field">
              <span>{t("fieldOptimization")}</span>
              <select
                value={config.optimization}
                onChange={(e) =>
                  update("optimization", e.target.value as Optimization)
                }
              >
                <option value="exact">{t("optExact")}</option>
                <option value="fast-overdraw">{t("optFastOverdraw")}</option>
                <option value="safe-overdraw">{t("optSafeOverdraw")}</option>
              </select>
            </label>

            <label className="field">
              <span>{t("fieldPixelSize")}</span>
              <input
                type="number"
                min="0.01"
                step="0.1"
                value={config.pixelSize}
                onChange={(e) =>
                  update("pixelSize", numberValue(e.target.value, 10))
                }
              />
            </label>

            <label className="field">
              <span>{t("fieldRotation")}</span>
              <input
                type="number"
                step="0.1"
                value={config.imageRotation}
                onChange={(e) =>
                  update("imageRotation", numberValue(e.target.value, 0))
                }
              />
            </label>
          </div>

          <h2 className="section-title">{t("sectionDeviceScales")}</h2>
          <div className="scale-config-row" aria-label={t("deviceScalesAria")}>
            {DEVICE_SCALE_FIELDS.map(({ key, labelKey }) => (
              <label className="field scale-field" key={key}>
                <span>{t("deviceScaleLabel", { label: t(labelKey) })}</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.05"
                  value={config.deviceScales[key]}
                  onChange={(e) =>
                    updateDeviceScale(key, numberValue(e.target.value, 1))
                  }
                />
              </label>
            ))}
          </div>

          <details
            className="advanced"
            open={advancedOpen}
            onToggle={(e) =>
              setAdvancedOpen((e.target as HTMLDetailsElement).open)
            }
          >
            <summary>{t("advancedSettings")}</summary>
            <div className="control-grid advanced-grid">
              <label className="field">
                <span>{t("fieldParentName")}</span>
                <input
                  value={config.parentName}
                  onChange={(e) => update("parentName", e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t("fieldParentX")}</span>
                <input
                  type="number"
                  value={config.parentX}
                  onChange={(e) =>
                    update("parentX", numberValue(e.target.value, 0))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldParentY")}</span>
                <input
                  type="number"
                  value={config.parentY}
                  onChange={(e) =>
                    update("parentY", numberValue(e.target.value, 0))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldFieldScale")}</span>
                <input
                  type="number"
                  step="0.01"
                  value={config.fieldScale}
                  onChange={(e) =>
                    update("fieldScale", numberValue(e.target.value, 0.5))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldLayerOrder")}</span>
                <select
                  value={config.exportLayerOrder}
                  onChange={(e) =>
                    update(
                      "exportLayerOrder",
                      e.target.value as GeneratorConfig["exportLayerOrder"]
                    )
                  }
                >
                  <option value="front-to-back">{t("orderFrontToBack")}</option>
                  <option value="back-to-front">{t("orderBackToFront")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("fieldMergePasses")}</span>
                <input
                  type="number"
                  min="0"
                  value={config.maxMergePasses}
                  onChange={(e) =>
                    update("maxMergePasses", numberValue(e.target.value, 200))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldMaxOverdrawRatio")}</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={config.maxOverdrawRatio}
                  onChange={(e) =>
                    update("maxOverdrawRatio", numberValue(e.target.value, 2.5))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldSafeTimeSeconds")}</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.5"
                  value={config.safeTimeSeconds}
                  onChange={(e) =>
                    update("safeTimeSeconds", numberValue(e.target.value, 10))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldUnderpaintBBoxRatio")}</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={config.underpaintMaxBBoxRatio}
                  onChange={(e) =>
                    update(
                      "underpaintMaxBBoxRatio",
                      numberValue(e.target.value, 6)
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldUnderpaintMinPixels")}</span>
                <input
                  type="number"
                  min="1"
                  value={config.underpaintMinComponentPixels}
                  onChange={(e) =>
                    update(
                      "underpaintMinComponentPixels",
                      numberValue(e.target.value, 8)
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldUnderpaintMinSavings")}</span>
                <input
                  type="number"
                  min="1"
                  value={config.underpaintMinSavings}
                  onChange={(e) =>
                    update(
                      "underpaintMinSavings",
                      numberValue(e.target.value, 2)
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldUnderpaintBeamWidth")}</span>
                <input
                  type="number"
                  min="1"
                  value={config.underpaintBeamWidth}
                  onChange={(e) =>
                    update(
                      "underpaintBeamWidth",
                      numberValue(e.target.value, 64)
                    )
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldUnderpaintBeamCandidates")}</span>
                <input
                  type="number"
                  min="1"
                  value={config.underpaintBeamCandidates}
                  onChange={(e) =>
                    update(
                      "underpaintBeamCandidates",
                      numberValue(e.target.value, 256)
                    )
                  }
                />
              </label>
              <label className="field checkbox-field">
                <span>{t("fieldKeepParentPosition")}</span>
                <input
                  type="checkbox"
                  checked={config.keepParentPosition}
                  onChange={(e) =>
                    update("keepParentPosition", e.target.checked)
                  }
                />
              </label>
              <label className="field checkbox-field">
                <span>{t("fieldYDown")}</span>
                <input
                  type="checkbox"
                  checked={config.yDown}
                  onChange={(e) => update("yDown", e.target.checked)}
                />
              </label>
              <label className="field">
                <span>{t("fieldStage1Passes")}</span>
                <input
                  type="number"
                  min="0"
                  value={config.stage1Passes}
                  onChange={(e) =>
                    update("stage1Passes", numberValue(e.target.value, 300))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldStage1Ratio")}</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={config.stage1Ratio}
                  onChange={(e) =>
                    update("stage1Ratio", numberValue(e.target.value, 3))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldStage2Passes")}</span>
                <input
                  type="number"
                  min="0"
                  value={config.stage2Passes}
                  onChange={(e) =>
                    update("stage2Passes", numberValue(e.target.value, 800))
                  }
                />
              </label>
              <label className="field">
                <span>{t("fieldStage2Ratio")}</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={config.stage2Ratio}
                  onChange={(e) =>
                    update("stage2Ratio", numberValue(e.target.value, 10))
                  }
                />
              </label>
            </div>
          </details>

          <div className="cta-row">
            <button
              className="primary-btn"
              disabled={!canGenerate}
              onClick={handleGenerate}
            >
              {busy ? t("btnGenerating") : t("btnGenerate")}
            </button>
            <button
              className={`secondary-btn ${canDownload ? "" : "disabled"}`}
              disabled={!canDownload}
              onClick={handleDownload}
            >
              {t("btnDownload")}
            </button>
          </div>

          <div className="status-panel">
            <div>
              <span className="mini-label">{t("labelStatus")}</span>
              <p>{statusText}</p>
            </div>
            <div>
              <span className="mini-label">{t("labelLastExport")}</span>
              <p>{summary}</p>
            </div>
            <div className="json-export-control">
              <select
                aria-label="JSON export format"
                value={jsonMode}
                disabled={!file || busy}
                onChange={(event) =>
                  setJsonMode(event.target.value as JsonExportMode)
                }
              >
                <option value="raw">Raw JSON</option>
                <option value="normalized">Normalized JSON</option>
              </select>
              <button
                className={`json-export-btn ${canExportJson ? "" : "disabled"}`}
                disabled={!canExportJson}
                onClick={handleJsonExport}
              >
                Generate & Download JSON
              </button>
              {lastJson && !busy && (
                <button type="button" onClick={handleViewJson}>
                  View JSON
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="right-pane">
          <div className="preview-frame preview-stack">
            {previewUrl ? (
              DEVICE_SCALE_FIELDS.map(({ key, labelKey }) => {
                const scale = config.deviceScales[key];
                // Keep the biggest preview under 100% so rotation has room and
                // the image does not clip into the preview-card border.
                const relativeWidth = `${Math.max(
                  8,
                  Math.min(
                    72,
                    (scale / maxPreviewScale) *
                      48 *
                      previewPixelScale *
                      previewRotationFit
                  )
                )}%`;
                return (
                  <div className="scaled-preview" key={key}>
                    <div className="preview-label">
                      <span>{t(labelKey)}</span>
                      <strong>
                        {t("previewScale", {
                          value: (scale * previewPixelScale).toFixed(2),
                        })}
                      </strong>
                    </div>
                    <div className="preview-image-row">
                      <div className="preview-transform-box">
                        <img
                          src={previewUrl}
                          alt={t("previewAlt", { label: t(labelKey) })}
                          style={{
                            width: relativeWidth,
                            transform: `rotate(${-config.imageRotation}deg)`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty-preview">{t("previewEmpty")}</div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
