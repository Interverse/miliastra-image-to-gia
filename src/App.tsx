import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GeneratorConfig,
  GenerationStats,
  Optimization,
} from "./lib/types";
import type { WorkerRequest, WorkerResponse } from "./workers/generator.worker";

const DEFAULT_CONFIG: GeneratorConfig = {
  optimization: "safe-overdraw",
  pixelSize: 10,
  imageRotation: 0,
  parentName: "Shapes",
  parentX: 0,
  parentY: 0,
  fieldScale: 0.5,
  keepParentPosition: false,
  yDown: false,
  exportLayerOrder: "front-to-back",
  maxMergePasses: 250,
  safeTimeSeconds: 10,
  stage1Passes: 300,
  stage1Ratio: 3,
  stage2Passes: 800,
  stage2Ratio: 10,
};

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

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const [config, setConfig] = useState<GeneratorConfig>(DEFAULT_CONFIG);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("Choose a PNG to begin.");
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [downloadName, setDownloadName] = useState<string>("output.gia");
  const [stats, setStats] = useState<GenerationStats | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const worker = new Worker(
      new URL("./workers/generator.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setStatus(msg.message);
      } else if (msg.type === "done") {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        const blob = new Blob([msg.giaBytes], {
          type: "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);
        setDownloadName(msg.downloadName);
        setStats(msg.stats);
        setStatus(`Done. ${msg.stats.shapeCount} shapes generated.`);
        setBusy(false);
      } else if (msg.type === "error") {
        setStatus(`Error: ${msg.error}`);
        setBusy(false);
      }
    };
    return () => {
      worker.terminate();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
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
  const canDownload = !!downloadUrl && !busy;

  const summary = useMemo(() => {
    if (!stats) return "No export yet.";
    return `${stats.width}×${stats.height} · ${stats.shapeCount} shapes · ${(
      stats.elapsedMs / 1000
    ).toFixed(2)}s`;
  }, [stats]);

  async function handleGenerate() {
    if (!file || !workerRef.current) return;
    setBusy(true);
    setStats(null);
    setDownloadUrl("");
    setStatus("Reading PNG");

    try {
      const imageData = await fileToImageData(file);
      const payload: WorkerRequest = {
        imageData,
        config,
        assetBase: new URL("./", window.location.href).href,
        fileName: file.name,
      };
      workerRef.current.postMessage(payload);
    } catch (error) {
      setStatus(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      setBusy(false);
    }
  }

  function update<K extends keyof GeneratorConfig>(
    key: K,
    value: GeneratorConfig[K]
  ) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function handleImageChange(nextFile: File | null) {
    setFile(nextFile);
    setDownloadUrl("");
    setStats(null);

    if (nextFile) {
      const nextParentName = parentNameFromFile(nextFile);
      setConfig((prev) => ({
        ...prev,
        parentName: nextParentName,
      }));
      setStatus(
        `Loaded ${nextFile.name}. Parent name set to "${nextParentName}".`
      );
    } else {
      setConfig((prev) => ({
        ...prev,
        parentName: DEFAULT_CONFIG.parentName,
      }));
      setStatus("Choose a PNG to begin.");
    }
  }

  return (
    <div className="shell">
      <div className="backdrop" />
      <main className="app-card">
        <section className="left-pane">
          <div className="title-block">
            <p className="eyebrow">GIA Pixel Builder</p>
            <h1>PNG → .gia</h1>
            <p className="subtitle">
              Browser-only .gia generator for pixel art. Higher res images may
              cause slowdown in game.
            </p>
          </div>

          <div className="control-grid">
            <label className="field field-file">
              <span>Image</span>
              <input
                type="file"
                accept="image/png"
                onChange={(e) => handleImageChange(e.target.files?.[0] ?? null)}
              />
            </label>

            <label className="field">
              <span>Optimization</span>
              <select
                value={config.optimization}
                onChange={(e) =>
                  update("optimization", e.target.value as Optimization)
                }
              >
                <option value="exact">Exact</option>
                <option value="fast-overdraw">Fast Overdraw</option>
                <option value="safe-overdraw">Safe Overdraw</option>
              </select>
            </label>

            <label className="field">
              <span>Pixel Size</span>
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
              <span>Rotation</span>
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

          <details
            className="advanced"
            open={advancedOpen}
            onToggle={(e) =>
              setAdvancedOpen((e.target as HTMLDetailsElement).open)
            }
          >
            <summary>Advanced Settings</summary>
            <div className="control-grid advanced-grid">
              <label className="field">
                <span>Parent Name</span>
                <input
                  value={config.parentName}
                  onChange={(e) => update("parentName", e.target.value)}
                />
              </label>
              <label className="field">
                <span>Parent X</span>
                <input
                  type="number"
                  value={config.parentX}
                  onChange={(e) =>
                    update("parentX", numberValue(e.target.value, 0))
                  }
                />
              </label>
              <label className="field">
                <span>Parent Y</span>
                <input
                  type="number"
                  value={config.parentY}
                  onChange={(e) =>
                    update("parentY", numberValue(e.target.value, 0))
                  }
                />
              </label>
              <label className="field">
                <span>Field Scale</span>
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
                <span>Layer Order</span>
                <select
                  value={config.exportLayerOrder}
                  onChange={(e) =>
                    update(
                      "exportLayerOrder",
                      e.target.value as GeneratorConfig["exportLayerOrder"]
                    )
                  }
                >
                  <option value="front-to-back">Front to Back</option>
                  <option value="back-to-front">Back to Front</option>
                </select>
              </label>
              <label className="field">
                <span>Merge Passes</span>
                <input
                  type="number"
                  min="0"
                  value={config.maxMergePasses}
                  onChange={(e) =>
                    update("maxMergePasses", numberValue(e.target.value, 250))
                  }
                />
              </label>
              <label className="field checkbox-field">
                <span>Keep Parent Position</span>
                <input
                  type="checkbox"
                  checked={config.keepParentPosition}
                  onChange={(e) =>
                    update("keepParentPosition", e.target.checked)
                  }
                />
              </label>
              <label className="field checkbox-field">
                <span>Y Down Coordinates</span>
                <input
                  type="checkbox"
                  checked={config.yDown}
                  onChange={(e) => update("yDown", e.target.checked)}
                />
              </label>
              <label className="field">
                <span>Stage 1 Passes</span>
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
                <span>Stage 1 Ratio</span>
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
                <span>Stage 2 Passes</span>
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
                <span>Stage 2 Ratio</span>
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
              {busy ? "Generating…" : "Generate .gia"}
            </button>
            <a
              className={`secondary-btn ${canDownload ? "" : "disabled"}`}
              href={canDownload ? downloadUrl : undefined}
              download={downloadName}
              aria-disabled={!canDownload}
              onClick={(e) => {
                if (!canDownload) e.preventDefault();
              }}
            >
              Download .gia
            </a>
          </div>

          <div className="status-panel">
            <div>
              <span className="mini-label">Status</span>
              <p>{status}</p>
            </div>
            <div>
              <span className="mini-label">Last Export</span>
              <p>{summary}</p>
            </div>
          </div>
        </section>

        <section className="right-pane">
          <div className="preview-frame">
            {previewUrl ? (
              <img src={previewUrl} alt="PNG preview" />
            ) : (
              <div className="empty-preview">PNG preview</div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
