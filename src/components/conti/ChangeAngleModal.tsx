/**
 * ChangeAngleModal — Interactive camera-angle change controls.
 *
 * Backend model defaults to GPT Image 1.5 (OpenAI vision-edits route, see
 * `[electron/api-handlers.ts](preflow-app/electron/api-handlers.ts)`
 * `isAngleGptModel` branch). image-1.5 is ~4-5× faster than image-2
 * (~30-60 s vs 2-3 min) and accepts `input_fidelity:high` for tighter
 * identity preservation. It reconstructs camera orbits — back, profile,
 * top-down, worm's-eye — well enough that we expose the entire sphere
 * via the controls below. image-2 is kept as a fallback toggle for
 * cases where 1.5 misses a tricky orbit.
 *
 * Direction convention (important — the prompt depends on this):
 *   yaw > 0 = camera moves to the subject's anatomical RIGHT side
 *            (the same side as the subject's right shoulder/hand).
 *            User mental model: "drag dot/slider right → see subject's
 *            right side." This avoids the cinematographer-jargon
 *            interpretation ("orbited right" = camera moves
 *            viewer-right = subject's left visible) which made the model
 *            flip results randomly. See `yawPhrase` below for the
 *            anatomy-anchored clauses, and `preserveBlock` in
 *            `cameraLibrary.ts` for the matching no-mirror rule.
 *
 * Controls:
 *   - Sphere pad (yaw + pitch): drag a dot around a unit sphere.
 *       • yaw   -180 ~ +180  (±180 = directly behind subject)
 *       • pitch -90  ~ +90   (−: low-angle / +: high-angle)
 *       • Front hemisphere = solid dot, back hemisphere = dashed ring.
 *   - Zoom slider: -100 ~ +100, prompt-rendered as a physical camera dolly
 *     so the whole frame reframes (not a crop).
 *   - Additional notes: free text appended verbatim.
 *   - Model: gpt-image-1.5 (default) | gpt-image-2 (slower fallback).
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { HelpCircle, Move3d, RotateCcw, X } from "lucide-react";

/* 3D 궤도 위젯은 three.js(~600KB) 를 끌어오므로 모달 진입 시에만 로드되도록
 * lazy 청크로 분리한다. base:"./" 상대경로 빌드라 Electron file:// 에서도 정상. */
const OrbitSphere3D = lazy(() => import("./OrbitSphere3D"));
import type { Scene, Asset } from "./contiTypes";
import { IMAGE_SIZE_MAP } from "@/lib/conti";
import { getImageModelDefault, getGptQualityDefault } from "@/lib/imageGenPreference";
import { buildAdvancedChainPrompt } from "@/lib/cameraLibrary";
import { buildSubjectDescriptor } from "@/lib/subjectDescriptor";
import { useT, useUiLanguage, type UiLanguage } from "@/lib/uiLanguage";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

type VideoFormat = keyof typeof IMAGE_SIZE_MAP;

/** 섹션 헤더 옆 (?) 호버 툴팁 — verbose 설명을 본문에서 분리해 기본 UI 는
 *  심플하게 유지. RelightModal 의 HelpHint 와 동일 패턴. */
const HelpHint = ({ text }: { text: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground/80 transition-colors"
        onClick={(e) => e.preventDefault()}
        aria-label="help"
      >
        <HelpCircle className="w-3 h-3" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
      {text}
    </TooltipContent>
  </Tooltip>
);

/* ━━━ Types ━━━ */
interface ChangeAngleConfig {
  /** -180 ~ +180. 음수 = 왼쪽, 양수 = 오른쪽. 0 = 원본 유지. */
  yaw: number;
  /** -90 ~ +90. 음수 = 아래→위(low-angle, uplook), 양수 = 위→아래(high-angle, downlook). */
  pitch: number;
  /** -100 ~ +100. 음수 = dolly-out, 양수 = dolly-in. */
  zoom: number;
  /** 프롬프트에 이어붙일 추가 설명 (optional) */
  customText: string;
}

const DEFAULT_CONFIG: ChangeAngleConfig = {
  yaw: 0,
  pitch: 0,
  zoom: 0,
  customText: "",
};

/* Full orbit range. Both image-1.5 (default) and image-2 handle back /
 * overhead / worm's-eye acceptably from a single reference, so the
 * modal opens up the whole sphere and lets users go anywhere with one
 * drag or one preset click. */
const YAW_MAX = 180;
const PITCH_MAX = 90;
const ZOOM_MAX = 100;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/* Orbit preset chips — one-click snaps for the angles that are awkward to
 * land precisely with sphere drag (profiles, full back, overhead, etc.).
 * Click sets yaw + pitch only; zoom stays where the user left it. */
interface OrbitPreset {
  id: string;
  label: string;
  yaw: number;
  pitch: number;
}
const ORBIT_PRESETS: OrbitPreset[] = [
  { id: "front",     label: "Front",     yaw: 0,    pitch: 0   },
  { id: "back",      label: "Back",      yaw: 180,  pitch: 0   },
  { id: "high",      label: "High",      yaw: 0,    pitch: 30  },
  { id: "low",       label: "Low",       yaw: 0,    pitch: -30 },
  { id: "overhead",  label: "Overhead",  yaw: 0,    pitch: 85  },
];

const ORBIT_PRESET_LABEL_KO: Record<string, string> = {
  front: "정면",
  back: "후면",
  high: "하이앵글",
  low: "로우앵글",
  overhead: "오버헤드",
};

const getOrbitPresetLabel = (preset: OrbitPreset, language: UiLanguage) =>
  language === "ko" ? (ORBIT_PRESET_LABEL_KO[preset.id] ?? preset.label) : preset.label;

/* ━━━ Prompt Construction ━━━
 *
 * Both gpt-image variants take a single declarative camera-position
 * phrase and a preserve list. We map the (yaw, pitch, zoom) sliders to
 * short natural language clauses and hand them to
 * `buildAdvancedChainPrompt`, which leads with "Re-photograph the EXACT
 * SAME scene…" and appends a strict preservation block so identity /
 * costume / set / lighting hold.
 *
 * Each phrase function returns null for a near-zero slider value, so the
 * builder can omit unused axes instead of writing "orbited 0° around…".
 */

/** yaw → camera position clause. Covers the full ±180° orbit.
 *
 * Convention: yaw > 0 means the camera has moved to the subject's
 * RIGHT side. Matches the user's intuition for the sphere dot ("drag
 * right slider → I want to see the subject's right side").
 *
 * Wording rule — keep this SUBJECT-AGNOSTIC:
 *   Do NOT name body parts (right ear / right cheek / right shoulder
 *   etc.). Earlier versions did, and for non-human subjects (weapons
 *   on a platform, vehicles, props, empty environments) the model
 *   hallucinated a human just to satisfy the anatomical clauses —
 *   weapon stills suddenly grew a soldier, etc.
 *   Use spatial side language only ("the RIGHT side of the subject",
 *   "the back side"). The image model already sees the reference and
 *   can map "right side" onto whatever the subject is — a person, a
 *   rifle, a building — without us suggesting anatomy.
 *   Cinematographer-jargon ("orbited to the right around the subject")
 *   is also banned, because it has the opposite reading of the user's
 *   sphere convention and the model flips results randomly when both
 *   readings are present. Each phrase drops into
 *   `buildAdvancedChainPrompt`'s "Frame it as ___, then make it ___"
 *   template (no leading "The camera…", no trailing period).
 *
 * Bearing anchor (added on top of the verbal RIGHT/LEFT cues):
 *   The single biggest leftover failure mode after the subject-agnostic
 *   rewrite is the model still occasionally flipping the side — image
 *   models are trained with horizontal-flip augmentation so "right" and
 *   "left" are nearly interchangeable in their latent space. We shore
 *   that up by appending a numeric camera-bearing reference to every
 *   yaw phrase. Convention:
 *     • The subject's original facing direction defines bearing 0°.
 *     • Original camera always sits at bearing 0° in front of the subject.
 *     • Subject's RIGHT side uses positive rotation (roughly 90°);
 *       subject's LEFT side uses the complementary bearing (roughly 270°).
 *     • yaw=±180 collapses to bearing 180° (full back).
 *   Integer bearings are far more flip-resistant than the word "right"
 *   because the number carries its own internal asymmetry ("30 vs 330",
 *   "90 vs 270"). The model can also cross-check the bearing against the
 *   verbal RIGHT/LEFT and pick the consistent reading, which is exactly
 *   what we want. We keep the reference explicitly geometric so it cannot
 *   be interpreted as an object to render in the scene. */
const yawPhrase = (yaw: number): string | null => {
  const a = Math.round(clamp(yaw, -YAW_MAX, YAW_MAX));
  if (Math.abs(a) < 8) return null;
  const abs = Math.abs(a);
  const side = a > 0 ? "right" : "left";
  const otherSide = a > 0 ? "left" : "right";
  const SIDE = side.toUpperCase();

  const isFullBack = abs > 150;
  const bearingAbs = isFullBack ? 180 : abs;
  const bearingSigned = isFullBack ? 180 : (a > 0 ? bearingAbs : 360 - bearingAbs);
  const bearingAnchor = isFullBack
    ? `camera bearing reference (geometric only, never visible in the rendered image): the subject's original facing direction defines bearing 0°. The original camera was at bearing 0° in front of the subject. The new camera is at bearing 180° around the subject — directly behind, on the opposite side from the original camera (≈ ${bearingAbs}° rotation around the subject's vertical axis)`
    : `camera bearing reference (geometric only, never visible in the rendered image): the subject's original facing direction defines bearing 0°. The original camera was at bearing 0° in front of the subject. The new camera is at bearing ${bearingSigned}° around the subject, placing it on the subject's ${SIDE} side`;

  if (abs <= 22)
    return `a view shifted slightly toward the ${SIDE} side of the subject — the subject is still mostly front-facing, but the ${side} side is a little more visible than before, the ${otherSide} side is a little less (${bearingAnchor})`;
  if (abs <= 45)
    return `a three-quarter view from the ${SIDE} side of the subject — the ${side} side is now clearly the dominant face we see; the ${otherSide} side is partly hidden (${bearingAnchor})`;
  if (abs <= 80)
    return `a strong three-quarter-to-profile view from the ${SIDE} side of the subject — most of the ${side} side is visible, only a narrow sliver of the ${otherSide} side remains in view (${bearingAnchor})`;
  if (abs <= 110)
    return `a pure ${SIDE}-side profile of the subject — the camera is directly to the subject's ${side}, viewing the subject from that side; the original-front is now in silhouette, the ${otherSide} side is fully hidden behind the subject (${bearingAnchor})`;
  if (abs <= 150)
    return `a view from BEHIND and slightly to the ${SIDE} of the subject — the camera has swung most of the way around toward the back-${side}; we see mostly the back of the subject, with just a hint of the ${side} side still in view (${bearingAnchor})`;
  return `a full BACK VIEW directly behind the subject — only the back is visible; the original-front of the subject is fully hidden, no front-facing details visible (${bearingAnchor})`;
};

/** pitch → camera position clause. Covers the full ±90° tilt. */
const pitchPhrase = (pitch: number): string | null => {
  const a = Math.round(clamp(pitch, -PITCH_MAX, PITCH_MAX));
  if (Math.abs(a) < 6) return null;
  if (a > 0) {
    if (a <= 20) return "slightly above eye level (mild high-angle shot, camera tilted slightly down at the subject)";
    if (a <= 45) return "clearly above the subject (moderate high-angle shot, camera tilted down at the subject)";
    if (a <= 75) return "well above the subject (strong high-angle shot from above, looking down steeply at the subject)";
    return "directly overhead, lens pointed straight down — OVERHEAD TOP-DOWN / BIRD'S-EYE shot, the subject and the floor around them laid out as a flat composition";
  }
  const abs = -a;
  if (abs <= 20) return "slightly below eye level (mild low-angle shot, camera tilted slightly up at the subject)";
  if (abs <= 45) return "clearly below the subject (moderate low-angle shot, camera tilted up at the subject)";
  if (abs <= 75) return "well below the subject (strong low-angle heroic shot, looking up steeply, the subject towers in the frame)";
  return "at ground level looking almost straight up — WORM'S-EYE VIEW, the subject looms enormous overhead, sky or ceiling dominates the top of the frame";
};

/** zoom → camera position clause. Covers ±100% physical dolly. */
const zoomPhrase = (zoom: number): string | null => {
  const a = Math.round(clamp(zoom, -ZOOM_MAX, ZOOM_MAX));
  if (Math.abs(a) < 6) return null;
  if (a > 0) {
    if (a <= 25) return "dollied slightly closer to the subject (push-in, medium-close framing)";
    if (a <= 60) return "dollied noticeably closer to the subject (close-up framing, subject takes up more of the frame)";
    return "dollied all the way in to the subject (tight close-up, the subject's face and upper body fill the frame, background reduced to soft bokeh)";
  }
  const abs = -a;
  if (abs <= 25) return "dollied slightly back from the subject (pull-back, slightly wider framing)";
  if (abs <= 60) return "dollied noticeably back from the subject (wide shot, subject is smaller in frame and more of the surrounding environment is visible)";
  return "dollied far back from the subject (extreme wide shot, the subject is small within the full environment, clear foreground / midground / background layers)";
};

/** 슬라이더 옆 요약 라벨(짧게). */
const summarizeYaw = (yaw: number): string => {
  const a = Math.round(yaw);
  if (Math.abs(a) < 8) return "same";
  return `${a > 0 ? "R" : "L"} ${Math.abs(a)}°`;
};
const summarizePitch = (pitch: number): string => {
  const a = Math.round(pitch);
  if (Math.abs(a) < 6) return "same";
  return a > 0 ? `down ${a}°` : `up ${-a}°`;
};
const summarizeZoom = (zoom: number): string => {
  const a = Math.round(zoom);
  if (Math.abs(a) < 6) return "same";
  if (a > 0) return `in ${a}%`;
  return `out ${-a}%`;
};

/* 회전(Rotation) 표현 — UI 는 "정면=0°, 시계 방향으로 0~350°" 단방향 다이얼로
 * 노출하고, 내부 yaw(-180~180, 우측+/좌측−) 와는 아래 함수로 변환한다.
 *   rotation 0   = 정면(yaw 0)
 *   rotation 90  = 우측 프로필(yaw 90)
 *   rotation 180 = 후면(yaw 180)
 *   rotation 270 = 좌측 프로필(yaw -90)
 *   rotation 350 = 살짝 좌측(yaw -10)
 * 이 변환은 표시/입력 전용이라 프롬프트(yawPhrase) 의미는 그대로 유지된다. */
const ROTATION_MAX = 350;
const rotationFromYaw = (yaw: number): number => {
  let r = Math.round(yaw >= 0 ? yaw : yaw + 360);
  if (r >= 360) r -= 360;
  return r;
};
const yawFromRotation = (rot: number): number => (rot <= 180 ? rot : rot - 360);
const summarizeRotationUi = (yaw: number, language: UiLanguage): string => {
  const r = rotationFromYaw(yaw);
  if (r === 0) return language === "ko" ? "정면" : "front";
  return `${r}°`;
};

const summarizePitchUi = (pitch: number, language: UiLanguage): string => {
  const a = Math.round(pitch);
  if (Math.abs(a) < 6) return language === "ko" ? "동일" : "same";
  if (language === "ko") return a > 0 ? `아래 ${a}°` : `위 ${-a}°`;
  return a > 0 ? `down ${a}°` : `up ${-a}°`;
};

const summarizeZoomUi = (zoom: number, language: UiLanguage): string => {
  const a = Math.round(zoom);
  if (Math.abs(a) < 6) return language === "ko" ? "동일" : "same";
  if (language === "ko") return a > 0 ? `앞으로 ${a}%` : `뒤로 ${-a}%`;
  if (a > 0) return `in ${a}%`;
  return `out ${-a}%`;
};

/* Prompt construction delegates to buildAdvancedChainPrompt in the shared
 * camera library. The "A, then B" chain pattern (yaw+zoom as one clause,
 * pitch as a second step) has measurably better NB2 adherence than the
 * older stacked-adjective run — NB2 would routinely collapse
 * "pulled back, and 30° right orbit, and tilted up" into just the first
 * clause. Routing both to the library also means any future prompt
 * tuning happens in one place, not three.
 *
 * Mapping from sliders → clauses:
 *   distanceClause = zoom + yaw   (framing bucket: "wider and orbited 30° right")
 *   angleClause    = pitch        ("tilted slightly up at the subject")
 *
 * Why group yaw with zoom: yaw without a distance change reads as a pure
 * orbit, and that's a framing adjustment; keeping it in the first chain
 * step lets the second step be a clean viewpoint tilt. */
const buildChangeAnglePrompt = (
  cfg: ChangeAngleConfig,
  subject: string,
): string => {
  const y = yawPhrase(cfg.yaw);
  const p = pitchPhrase(cfg.pitch);
  const z = zoomPhrase(cfg.zoom);

  const distanceParts = [z, y].filter((s): s is string => !!s);
  const distanceClause = distanceParts.length > 0 ? distanceParts.join(" and ") : null;
  const angleClause = p ?? null;

  return buildAdvancedChainPrompt({
    subject,
    distanceClause,
    angleClause,
    extraNotes: cfg.customText,
    // 4-B: yaw > 90° 일 때 preserveBlock 이 배경을 "새 시점에 맞게 변경" 으로
    // 전환하도록 yaw 절대값을 전달. 후면 전환 시 배경 불변 버그의 핵심 수정.
    yawAbs: Math.abs(cfg.yaw),
  });
};

/* ━━━ Orbit widget sizing ━━━
 * 3D 궤도 위젯(OrbitSphere3D)의 캔버스 한 변(px). 우측 컨트롤 그리드
 * 레이아웃(gridTemplateColumns)과 위젯 size prop 에 함께 쓰인다. */
const SPHERE_SIZE = 208;

/* SphereControl(SVG 의사 3D) 는 OrbitSphere3D(three.js) 로 대체됨.
 * yaw↔theta, pitch↔phi 항등 매핑은 아래 AngleOrbitWidget 어댑터가 담당. */

/* ━━━ Camera gizmo ━━━
 * OrbitSphere3D 의 marker 슬롯에 주입되는 카메라 모양 메쉬. 부모 group 은
 * three 의 Object3D.lookAt 규약상(일반 오브젝트는 +Z 가 타깃을 향함) 로컬
 * +Z 가 중앙(피사체)을 향하도록 정렬되므로, 렌즈 배럴을 +Z 로 빼두면 카메라가
 * 피사체를 겨눈다. 카메라가 구의 뒤쪽(피사체 반대편)으로 돌면 렌즈가 시청자
 * 쪽을 향하게 되어 렌즈가 또렷이 보인다. (조명용으로 교체 시 이 슬롯에 광원
 * 기즈모를 넣으면 됨) */
const CameraGizmo = ({ color }: { color: string }) => (
  <group scale={1.15}>
    {/* 바디 */}
    <mesh>
      <boxGeometry args={[0.17, 0.12, 0.085]} />
      <meshStandardMaterial color="#2b2b30" emissive={color} emissiveIntensity={0.1} roughness={0.55} metalness={0.35} />
    </mesh>
    {/* 상단 뷰파인더/펜타프리즘 돌기 */}
    <mesh position={[0.04, 0.082, 0]}>
      <boxGeometry args={[0.055, 0.045, 0.05]} />
      <meshStandardMaterial color="#37373d" roughness={0.6} metalness={0.25} />
    </mesh>
    {/* 셔터 버튼 */}
    <mesh position={[-0.055, 0.078, 0]}>
      <cylinderGeometry args={[0.012, 0.012, 0.02, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} roughness={0.3} />
    </mesh>
    {/* 렌즈 배럴 — +Z(피사체)를 향함 */}
    <mesh position={[0, 0, 0.085]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.046, 0.052, 0.09, 24]} />
      <meshStandardMaterial color="#1b1b1f" roughness={0.4} metalness={0.55} />
    </mesh>
    {/* 렌즈 림(테두리) */}
    <mesh position={[0, 0, 0.132]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.045, 0.045, 0.012, 24]} />
      <meshStandardMaterial color="#0e0e12" roughness={0.3} metalness={0.6} />
    </mesh>
    {/* 렌즈 글래스(강조색) */}
    <mesh position={[0, 0, 0.139]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.032, 0.032, 0.006, 24]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.85} roughness={0.15} metalness={0.2} />
    </mesh>
  </group>
);

/* ━━━ Angle adapter ━━━
 * yaw/pitch(도메인) ↔ theta/phi(범용) 항등 매핑으로 OrbitSphere3D 를 감싸는
 * 얇은 어댑터. 라이트 도메인은 같은 위젯을 azimuth/elevation 어댑터 + 상반구
 * 제약 + 광원 기즈모로 재사용할 수 있다. */
interface AngleOrbitWidgetProps {
  yaw: number;
  pitch: number;
  zoom: number;
  onChange: (v: { yaw: number; pitch: number }) => void;
  imageUrl?: string;
  disabled?: boolean;
  labels: { top: string; bottom: string };
}
const AngleOrbitWidget = ({ yaw, pitch, zoom, onChange, imageUrl, disabled, labels }: AngleOrbitWidgetProps) => (
  <OrbitSphere3D
    theta={yaw}
    phi={pitch}
    onChange={({ theta, phi }) => onChange({ yaw: theta, pitch: phi })}
    imageUrl={imageUrl}
    zoom={zoom}
    size={SPHERE_SIZE}
    disabled={disabled}
    thetaRange={[-YAW_MAX, YAW_MAX]}
    phiRange={[-PITCH_MAX, PITCH_MAX]}
    labels={{ top: labels.top, bottom: labels.bottom, left: "L", right: "R" }}
    accentColor="#f87171"
    marker={<CameraGizmo color="#f87171" />}
  />
);

/* ━━━ Small labeled slider (bi-polar: 중앙 = 0) ━━━ */
interface BiSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  endLabels: [string, string];
  onChange: (v: number) => void;
  disabled?: boolean;
  summary: string;
  resetTitle: string;
}
const BiSlider = ({
  label,
  value,
  min,
  max,
  step = 1,
  endLabels,
  onChange,
  disabled,
  summary,
  resetTitle,
}: BiSliderProps) => (
  <div>
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        fontSize: 11,
        color: "hsl(var(--foreground) / 0.62)",
        marginBottom: 6,
        userSelect: "none",
      }}
    >
      <span>{label}</span>
      <span style={{ color: "hsl(var(--foreground) / 0.42)", fontVariantNumeric: "tabular-nums" }}>{summary}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => onChange(0)}
      disabled={disabled}
      style={{ width: "100%", accentColor: "hsl(var(--primary))", cursor: disabled ? "default" : "pointer" }}
      title={resetTitle}
    />
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 9,
        color: "hsl(var(--foreground) / 0.32)",
        marginTop: 2,
        userSelect: "none",
      }}
    >
      <span>{endLabels[0]}</span>
      <span>{endLabels[1]}</span>
    </div>
  </div>
);

/* ━━━ Section wrapper ━━━ */
interface SectionProps {
  label: string;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  first?: boolean;
  help?: string;
  children: React.ReactNode;
}
const Section = ({ label, meta, icon, first, help, children }: SectionProps) => (
  <div
    style={{
      paddingTop: first ? 0 : 14,
      paddingBottom: 14,
      borderTop: first ? "none" : "1px solid hsl(var(--foreground) / 0.06)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 10,
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: "hsl(var(--foreground) / 0.82)",
          letterSpacing: 0.1,
        }}
      >
        {icon}
        {label}
        {help && <HelpHint text={help} />}
      </div>
      {meta !== undefined && meta !== null && (
        <div
          style={{
            fontSize: 10,
            color: "hsl(var(--foreground) / 0.42)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </div>
      )}
    </div>
    {children}
  </div>
);

/* ━━━ Main modal ━━━ */

/** Self-contained spec the parent needs to fire the actual generation in
 *  the background. The modal builds this from its UI state and hands it
 *  off via `onSubmit` — it does NOT call the network itself anymore.
 *
 *  Promoting the request to the parent lets ContiTab drive the same
 *  `editGeneratingIds` + `sceneStages` channels that inpaint already
 *  uses, so the user sees the standard `1/1 Generating…` spinner on the
 *  scene card with the modal out of the way. */
/** Model choices exposed by the modal's footer toggle. Mirrors the
 *  `preferredAngleModel` union in `electron/api-handlers.ts` (excluding
 *  `"nb2"` which is the non-GPT path and not selectable from this modal). */
export type ChangeAngleModel = "gpt-image-2" | "gpt-image-1.5";

export interface ChangeAngleSubmit {
  sceneId: string;
  sceneNumber: number;
  /** Source image at submit time — the parent uses this to push history
   *  before overwriting `conti_image_url`. */
  sourceImageUrl: string;
  /** Ready-to-invoke body for `supabase.functions.invoke("openai-image", ...)`.
   *  Carries `preferredAngleModel` set to whichever GPT variant the modal's
   *  footer toggle had selected at submit time. */
  body: Record<string, unknown>;
}

export interface ChangeAngleModalProps {
  scene: Scene;
  /** Asset library — threaded into the subject descriptor so NB2 gets
   *  a written identity anchor to complement the visual reference. */
  assets?: Asset[];
  projectId: string;
  videoFormat: VideoFormat;
  onClose: () => void;
  /** Hand off the built request to the parent. The modal closes itself
   *  right after; the parent runs the generation and drives the
   *  scene-card spinner. */
  onSubmit: (req: ChangeAngleSubmit) => void;
}

const BACKDROP_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "hsl(0 0% 0% / 0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};
const PANEL_STYLE: React.CSSProperties = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border-subtle))",
  boxShadow: "0 10px 15px -3px hsl(0 0% 0% / 0.5), 0 4px 6px -4px hsl(0 0% 0% / 0.4)",
  width: "min(960px, 100%)",
  height: "min(92vh, 780px)",
  display: "grid",
  gridTemplateColumns: "minmax(280px, 380px) 1fr",
  gridTemplateRows: "1fr",
  overflow: "hidden",
};

export function ChangeAngleModal({
  scene,
  assets = [],
  projectId,
  videoFormat,
  onClose,
  onSubmit,
}: ChangeAngleModalProps) {
  const t = useT();
  const { language } = useUiLanguage();
  const sourceUrl = scene.conti_image_url;
  const [cfg, setCfg] = useState<ChangeAngleConfig>(DEFAULT_CONFIG);
  /** Model toggle: which gpt-image variant to send the request to.
   *  Defaults to "gpt-image-1.5" — testing showed it handles camera
   *  angle changes well and is ~4-5× faster than image-2 (~30-60 s vs
   *  2-3 min) plus accepts `input_fidelity:high` for tighter identity
   *  preservation. image-2 stays available as the slower-but-fancier
   *  fallback for cases where 1.5 misses a tricky orbit. Initial value =
   *  Settings 의 angle 기본 모델; 모달 토글로 이번 적용에 한해 override 가능. */
  const [model, setModel] = useState<ChangeAngleModel>(
    () => getImageModelDefault("angle") as ChangeAngleModel,
  );
  /** With generation hoisted to the parent, the modal no longer carries
   *  an in-flight `applying` state — it builds the body and hands off.
   *  `error` is kept for prompt-construction-time validation only
   *  (e.g. missing source url), since real network errors now surface as
   *  toasts on the scene card. */
  const [error, setError] = useState<string | null>(null);
  // Modal hands off synchronously, so there's never a true in-flight state
  // here — kept as a constant so the existing `disabled` props on controls
  // stay readable.
  const applying = false;

  const subject = useMemo(
    () => buildSubjectDescriptor(scene, assets),
    [scene, assets],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const resetAll = () => {
    setCfg(DEFAULT_CONFIG);
    setError(null);
  };

  const handleApply = () => {
    if (!sourceUrl) {
      setError(t("variant.noSourceImage"));
      return;
    }
    const prompt = buildChangeAnglePrompt(cfg, subject);
    const body: Record<string, unknown> = {
      mode: "inpaint",
      sourceImageUrl: sourceUrl,
      referenceImageUrls: [],
      prompt,
      projectId,
      sceneNumber: scene.scene_number,
      imageSize: IMAGE_SIZE_MAP[videoFormat],
      preferredAngleModel: model,
      // 각도 변경은 GPT 전용 — 기능별 Settings 품질을 전달.
      quality: getGptQualityDefault("angle"),
    };
    console.log(`[ChangeAngle] handing off to parent (${model})`);
    onSubmit({
      sceneId: scene.id,
      sceneNumber: scene.scene_number,
      sourceImageUrl: sourceUrl,
      body,
    });
    onClose();
  };

  if (!sourceUrl) {
    return (
      <div style={BACKDROP_STYLE} onClick={onClose}>
        <div
          style={{ ...PANEL_STYLE, gridTemplateColumns: "1fr", padding: 24 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ color: "hsl(var(--foreground) / 0.7)", fontSize: 13 }}>{t("variant.noSourceImage")}</div>
        </div>
      </div>
    );
  }

  const nonZero = cfg.yaw !== 0 || cfg.pitch !== 0 || cfg.zoom !== 0;

  return (
    <div style={BACKDROP_STYLE} onClick={onClose}>
      <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
        {/* Preview */}
        <div
          style={{
            background: "hsl(var(--background))",
            borderRight: "1px solid hsl(var(--foreground) / 0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            minHeight: 320,
          }}
        >
          <img
            src={sourceUrl}
            alt={`Shot #${String(scene.scene_number).padStart(2, "0")}`}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
          />
        </div>

        {/* Controls */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 20px",
              borderBottom: "1px solid hsl(var(--foreground) / 0.06)",
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            <Move3d className="w-4 h-4" style={{ color: "hsl(var(--foreground) / 0.78)" }} />
            <div
              style={{
                color: "hsl(var(--foreground) / 0.95)",
                fontSize: 14,
                fontWeight: 600,
                flex: 1,
                letterSpacing: 0.1,
              }}
            >
              {t("conti.changeAngle")}
            </div>
            <button
              onClick={resetAll}
              disabled={applying || !nonZero}
              className="text-white/60 hover:text-white/90 disabled:opacity-30"
              style={{
                background: "transparent",
                border: "none",
                cursor: applying || !nonZero ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: "2px 6px",
              }}
              title={t("variant.resetAllTitle")}
            >
              <RotateCcw className="w-3 h-3" /> {t("variant.reset")}
            </button>
            <button
              onClick={onClose}
              disabled={applying}
              className="text-white/60 hover:text-white/90 disabled:opacity-40"
              style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex" }}
              title={t("variant.closeEsc")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: "4px 20px 6px", overflow: "auto", flex: 1, minHeight: 0 }}>
            {/* Orbit (yaw + pitch via sphere) */}
            <Section
              label={t("variant.orbitCamera")}
              first
              help={t("variant.orbitHelp")}
              meta={
                <span>
                  {t("variant.rotation")} <b style={{ color: "hsl(var(--foreground) / 0.7)" }}>{summarizeRotationUi(cfg.yaw, language)}</b>
                  <span style={{ opacity: 0.35, margin: "0 5px" }}>·</span>
                  {t("variant.pitch")} <b style={{ color: "hsl(var(--foreground) / 0.7)" }}>{summarizePitchUi(cfg.pitch, language)}</b>
                </span>
              }
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `${SPHERE_SIZE}px 1fr`,
                  gap: 18,
                  alignItems: "center",
                }}
              >
                <Suspense
                  fallback={
                    <div
                      style={{
                        width: SPHERE_SIZE,
                        height: SPHERE_SIZE,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "hsl(var(--foreground) / 0.4)",
                        fontSize: 11,
                      }}
                    >
                      3D…
                    </div>
                  }
                >
                  <AngleOrbitWidget
                    yaw={cfg.yaw}
                    pitch={cfg.pitch}
                    zoom={cfg.zoom}
                    onChange={({ yaw, pitch }) =>
                      setCfg((p) => ({
                        ...p,
                        yaw: clamp(yaw, -YAW_MAX, YAW_MAX),
                        pitch: clamp(pitch, -PITCH_MAX, PITCH_MAX),
                      }))
                    }
                    imageUrl={sourceUrl}
                    disabled={applying}
                    labels={{ top: t("variant.top"), bottom: t("variant.bottom") }}
                  />
                </Suspense>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                  <BiSlider
                    label={t("variant.rotation")}
                    value={rotationFromYaw(cfg.yaw)}
                    min={0}
                    max={ROTATION_MAX}
                    endLabels={[language === "ko" ? "정면" : "Front", `${ROTATION_MAX}°`]}
                    onChange={(v) => setCfg((p) => ({ ...p, yaw: yawFromRotation(clamp(v, 0, ROTATION_MAX)) }))}
                    disabled={applying}
                    summary={summarizeRotationUi(cfg.yaw, language)}
                    resetTitle={t("variant.doubleClickResetTitle")}
                  />
                  <BiSlider
                    label={t("variant.pitch")}
                    value={cfg.pitch}
                    min={-PITCH_MAX}
                    max={PITCH_MAX}
                    endLabels={[t("variant.down"), t("variant.up")]}
                    onChange={(v) => setCfg((p) => ({ ...p, pitch: clamp(v, -PITCH_MAX, PITCH_MAX) }))}
                    disabled={applying}
                    summary={summarizePitchUi(cfg.pitch, language)}
                    resetTitle={t("variant.doubleClickResetTitle")}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {ORBIT_PRESETS.map((preset) => {
                      const active =
                        Math.abs(cfg.yaw - preset.yaw) < 1 && Math.abs(cfg.pitch - preset.pitch) < 1;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => setCfg((p) => ({ ...p, yaw: preset.yaw, pitch: preset.pitch }))}
                          disabled={applying}
                          title={`${getOrbitPresetLabel(preset, language)} (${t("variant.rotation")} ${rotationFromYaw(preset.yaw)}°, ${t("variant.pitch")} ${preset.pitch}°)`}
                          className="hover:bg-white/[0.08] disabled:opacity-50"
                          style={{
                            padding: "4px 8px",
                            fontSize: 10,
                            background: active ? "hsl(var(--primary) / 0.2)" : "hsl(var(--foreground) / 0.04)",
                            border: `1px solid ${active ? "hsl(var(--primary) / 0.55)" : "hsl(var(--foreground) / 0.1)"}`,
                            color: active ? "#fca5a5" : "hsl(var(--foreground) / 0.82)",
                            cursor: applying ? "default" : "pointer",
                            transition: "background 120ms ease, border-color 120ms ease",
                            fontFamily: "inherit",
                          }}
                        >
                          {getOrbitPresetLabel(preset, language)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Section>

            {/* Zoom */}
            <Section
              label={t("variant.zoom")}
              help={t("variant.zoomHelp")}
              meta={
                <span>
                  <b style={{ color: "hsl(var(--foreground) / 0.7)" }}>{summarizeZoomUi(cfg.zoom, language)}</b>
                </span>
              }
            >
              <BiSlider
                label={t("variant.dolly")}
                value={cfg.zoom}
                min={-ZOOM_MAX}
                max={ZOOM_MAX}
                endLabels={[t("variant.pullBack"), t("variant.pushIn")]}
                onChange={(v) => setCfg((p) => ({ ...p, zoom: clamp(v, -ZOOM_MAX, ZOOM_MAX) }))}
                disabled={applying}
                summary={summarizeZoomUi(cfg.zoom, language)}
                resetTitle={t("variant.doubleClickResetTitle")}
              />
            </Section>

            {/* Additional notes */}
            <Section label={t("variant.notes")} meta={t("variant.optional")}>
              <textarea
                value={cfg.customText}
                onChange={(e) => setCfg((p) => ({ ...p, customText: e.target.value }))}
                disabled={applying}
                rows={2}
                placeholder={t("variant.changeAngleNotesPlaceholder")}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  background: "hsl(var(--input))",
                  border: "1px solid hsl(var(--foreground) / 0.08)",
                  color: "hsl(var(--foreground) / 0.88)",
                  fontSize: 11,
                  fontFamily: "inherit",
                  lineHeight: 1.55,
                  resize: "vertical",
                  outline: "none",
                }}
              />
            </Section>

            {error && (
              <div className="mt-1 mb-2.5 rounded-none border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-caption text-destructive-foreground">
                {error}
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "12px 20px",
              borderTop: "1px solid hsl(var(--foreground) / 0.06)",
              background: "hsl(var(--background))",
              flexShrink: 0,
            }}
          >
            {/* Test toggle: pick which gpt-image variant the apply will hit.
             *  Kept as a small segmented control so it doesn't compete with
             *  the orbit/zoom/notes controls above. */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "hsl(var(--foreground) / 0.55)",
              }}
              title={t("variant.angleModelTooltip")}
            >
              <span style={{ letterSpacing: 0.2 }}>{t("variant.angleModel")}</span>
              <div
                role="group"
                aria-label={t("variant.angleModelAria")}
                style={{
                  display: "inline-flex",
                  border: "1px solid hsl(var(--foreground) / 0.12)",
                  overflow: "hidden",
                }}
              >
                {(["gpt-image-1.5", "gpt-image-2"] as ChangeAngleModel[]).map((m) => {
                  const active = model === m;
                  const label = m === "gpt-image-2" ? "image-2" : "image-1.5";
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModel(m)}
                      disabled={applying}
                      aria-pressed={active}
                      style={{
                        padding: "4px 10px",
                        background: active ? "hsl(var(--primary) / 0.2)" : "transparent",
                        border: "none",
                        borderLeft: m === "gpt-image-2" ? "1px solid hsl(var(--foreground) / 0.12)" : "none",
                        color: active ? "#fca5a5" : "hsl(var(--foreground) / 0.72)",
                        cursor: applying ? "default" : "pointer",
                        fontSize: 11,
                        fontWeight: active ? 600 : 500,
                        fontFamily: "inherit",
                        letterSpacing: 0.2,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="inline-flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={applying}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleApply}
                className="min-w-[92px]"
                title={t("variant.submitAndCloseTitle")}
              >
                {t("conti.apply")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
