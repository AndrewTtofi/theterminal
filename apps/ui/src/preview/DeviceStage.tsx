import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DEVICES, viewport } from "@theterminal/shared";
import type { DeviceId } from "@theterminal/shared";
import "./preview.css";

type Size = { width: number; height: number };

/** How much a viewport shrinks to fit in a box: the smaller of the two ratios, never above 1 (never enlarged). */
export function fitScale(vp: Size, box: Size): number {
  if (vp.width <= 0 || vp.height <= 0) return 0;
  return Math.max(0, Math.min(1, box.width / vp.width, box.height / vp.height));
}

/** Space around and between the frames, and under each for its label (CSS pixels). */
const GAP = 24;
const PAD = 16;
const LABEL = 28;
/** Before the stage is measured (or where it cannot be), frames are drawn at a quarter of their size. */
const UNMEASURED = 0.25;

const shapeOf = (id: DeviceId): "phone" | "tablet" | "laptop" => (id === "laptop" ? "laptop" : id === "ipad" ? "tablet" : "phone");

export function deviceLabel(id: DeviceId, rotated: boolean): string {
  const vp = viewport(id, rotated);
  return `${DEVICES[id].label} · ${vp.width}×${vp.height}`;
}

type Props = {
  devices: readonly DeviceId[];
  rotated: readonly DeviceId[];
  /** What fills each device's screen, drawn at the device's own size and the stage's scale; empty for live views. */
  screen?: (id: DeviceId, vp: Size, scale: number) => ReactNode;
  /** The screen element of each device, after every layout change, for live views laid over them. */
  onFrames?: (frames: Map<DeviceId, HTMLElement>) => void;
};

/**
 * The device frames side by side, all at one scale so their sizes compare truly, measured to fit the stage. Each
 * frame keeps its place while data updates; only the stage's own size changes the scale.
 */
export function DeviceStage({ devices, rotated, screen, onFrames }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const screens = useRef(new Map<DeviceId, HTMLElement>());
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const onFramesRef = useRef(onFrames);
  onFramesRef.current = onFrames;

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sizes = devices.map((id) => viewport(id, rotated.includes(id)));
  const all: Size = { width: sizes.reduce((a, s) => a + s.width, 0), height: Math.max(0, ...sizes.map((s) => s.height)) };
  const room: Size = { width: box.width - 2 * PAD - GAP * Math.max(0, devices.length - 1), height: box.height - 2 * PAD - LABEL };
  const scale = box.width > 0 && box.height > 0 ? fitScale(all, room) : UNMEASURED;

  const signature = `${devices.join(",")}|${rotated.join(",")}`;
  useLayoutEffect(() => {
    const out = new Map<DeviceId, HTMLElement>();
    for (const id of devices) {
      const el = screens.current.get(id);
      if (el) out.set(id, el);
    }
    onFramesRef.current?.(out);
  }, [signature]);

  return (
    <div ref={stage} className="device-stage">
      {devices.map((id, i) => {
        const vp = sizes[i]!;
        const turned = rotated.includes(id);
        return (
          <figure key={id} className={`device device-${shapeOf(id)}${turned ? " rotated" : ""}`}>
            <div className="device-bezel">
              <div
                className="device-screen"
                style={{ width: Math.round(vp.width * scale), height: Math.round(vp.height * scale) }}
                ref={(el) => {
                  if (el) screens.current.set(id, el);
                  else screens.current.delete(id);
                }}
              >
                {screen?.(id, vp, scale)}
              </div>
            </div>
            <figcaption className="device-label num">{deviceLabel(id, turned)}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
