/**
 * OrbitSphere3D — 도메인 중립(generic) 3D 구면각 위젯.
 *
 * three.js(react-three-fiber) 로 와이어프레임 구 + 중앙 이미지 빌보드 +
 * 표면 위를 도는 마커(기즈모) + 마커→중앙 빔을 그린다. 사용자는 드래그로
 * 마커를 궤도 이동시키고, 그 위치가 `theta/phi`(도) 로 콜백된다.
 *
 * 의도적으로 yaw/pitch/azimuth 같은 도메인 용어를 모른다 — 카메라 앵글이든
 * 조명 방향이든, 호출 측에서 얇은 어댑터로 자기 도메인 각을 theta/phi 로
 * 매핑해 쓴다. (앵글: theta=yaw, phi=pitch / 조명: theta=azimuth, phi=elevation)
 *
 * 좌표 규약 (도메인 중립):
 *   x = sin(theta) * cos(phi)
 *   y = sin(phi)                 // phi>0 = 위
 *   z = cos(theta) * cos(phi)    // z>=0 = 앞 반구(뷰 카메라 쪽)
 *   marker.position = (x, y, z) * R
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Billboard, Line } from "@react-three/drei";
import { Group, Texture, TextureLoader, SRGBColorSpace } from "three";

const DEG = Math.PI / 180;
const SPHERE_R = 1;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export interface OrbitSphere3DProps {
  /** 일반화된 구면각. theta = 수평 회전, phi = 상하. 도(deg) 단위. */
  theta: number;
  phi: number;
  onChange: (next: { theta: number; phi: number }) => void;
  /** 구 중앙에 빌보드로 얹을 피사체 이미지 URL. */
  imageUrl?: string;
  /** -100~100. 중앙 이미지를 시각적으로 확대/축소(push-in/pull-back 느낌). */
  zoom?: number;
  /** 캔버스 한 변 px. */
  size?: number;
  disabled?: boolean;
  labels?: { top?: string; bottom?: string; left?: string; right?: string };
  /** theta 허용 범위(도). 기본 [-180, 180]. */
  thetaRange?: [number, number];
  /** phi 허용 범위(도). 앵글 [-90,90] / 조명 [0,90]. */
  phiRange?: [number, number];
  /** 조명용 편의 플래그 — 켜면 phiRange 를 [0,90] 로 강제. */
  constrainToUpperHemisphere?: boolean;
  /** 마커(기즈모) 슬롯. 미지정 시 기본 점 마커. group 의 -Z 가 중앙을 향하도록 배치됨. */
  marker?: React.ReactNode;
  /** 빔/마커 강조 색. */
  accentColor?: string;
  /** 더블클릭 리셋 시 복귀할 값. 기본 {0,0}. */
  resetTo?: { theta: number; phi: number };
}

/** (theta, phi)[deg] → 단위 구 위 좌표. */
const sphericalToXYZ = (thetaDeg: number, phiDeg: number, r = SPHERE_R): [number, number, number] => {
  const t = thetaDeg * DEG;
  const p = phiDeg * DEG;
  const cp = Math.cos(p);
  return [Math.sin(t) * cp * r, Math.sin(p) * r, Math.cos(t) * cp * r];
};

/** 위도/경도 와이어프레임 링 포인트 생성. */
const useWireframeRings = () =>
  useMemo(() => {
    const segs = 64;
    const latitudes = [-60, -30, 0, 30, 60];
    const longitudes = [0, 30, 60, 90, 120, 150];

    const latRings: [number, number, number][][] = latitudes.map((lat) => {
      const y = Math.sin(lat * DEG) * SPHERE_R;
      const rr = Math.cos(lat * DEG) * SPHERE_R;
      return Array.from({ length: segs + 1 }, (_, i) => {
        const a = (i / segs) * Math.PI * 2;
        return [rr * Math.cos(a), y, rr * Math.sin(a)] as [number, number, number];
      });
    });

    const lonRings: [number, number, number][][] = longitudes.map((lon) => {
      const c = Math.cos(lon * DEG);
      const s = Math.sin(lon * DEG);
      return Array.from({ length: segs + 1 }, (_, i) => {
        const a = (i / segs) * Math.PI * 2;
        const x = SPHERE_R * Math.cos(a) * c;
        const y = SPHERE_R * Math.sin(a);
        const z = SPHERE_R * Math.cos(a) * s;
        return [x, y, z] as [number, number, number];
      });
    });

    return { latRings, lonRings };
  }, []);

/** 중앙 피사체 이미지 빌보드. 텍스처 로드 실패해도 Canvas 가 죽지 않도록 수동 로드. */
function CenterImage({ url, scale = 1 }: { url?: string; scale?: number }) {
  const [texture, setTexture] = useState<Texture | null>(null);
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    if (!url) {
      setTexture(null);
      return;
    }
    let cancelled = false;
    const loader = new TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.colorSpace = SRGBColorSpace;
        const img = tex.image as { width?: number; height?: number } | undefined;
        if (img?.width && img?.height) setAspect(img.width / img.height);
        setTexture(tex);
      },
      undefined,
      () => {
        /* 로드 실패: 플레이스홀더 유지 */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  // 텍스처 언마운트 정리
  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  const w = 1.15;
  const h = w / Math.max(0.2, aspect);
  const border = 0.03;

  return (
    <Billboard>
      {/* zoom 에 따라 전체 이미지를 확대/축소 */}
      <group scale={scale}>
        {/* 살짝 큰 배경 평면 = 얇은 프레임 */}
        <mesh position={[0, 0, -0.001]}>
          <planeGeometry args={[w + border, h + border]} />
          <meshBasicMaterial color="#000000" transparent opacity={0.55} />
        </mesh>
        <mesh>
          <planeGeometry args={[w, h]} />
          {texture ? (
            <meshBasicMaterial map={texture} toneMapped={false} transparent />
          ) : (
            <meshBasicMaterial color="#2a2a2e" transparent opacity={0.85} />
          )}
        </mesh>
      </group>
    </Billboard>
  );
}

/** 마커 그룹: 표면 위치에 놓고 -Z 가 중앙을 향하도록 lookAt. */
function MarkerGroup({
  position,
  children,
  accentColor,
}: {
  position: [number, number, number];
  children?: React.ReactNode;
  accentColor: string;
}) {
  const ref = useRef<Group>(null);
  useLayoutEffect(() => {
    ref.current?.lookAt(0, 0, 0);
  }, [position]);
  return (
    <group ref={ref} position={position}>
      {children ?? (
        <mesh>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshBasicMaterial color={accentColor} />
        </mesh>
      )}
    </group>
  );
}

export default function OrbitSphere3D({
  theta,
  phi,
  onChange,
  imageUrl,
  zoom = 0,
  size = 208,
  disabled,
  labels,
  thetaRange = [-180, 180],
  phiRange = [-90, 90],
  constrainToUpperHemisphere,
  marker,
  accentColor = "#f87171",
  resetTo = { theta: 0, phi: 0 },
}: OrbitSphere3DProps) {
  const effPhiRange = useMemo<[number, number]>(
    () => (constrainToUpperHemisphere ? [0, 90] : phiRange),
    [constrainToUpperHemisphere, phiRange],
  );
  const { latRings, lonRings } = useWireframeRings();

  const markerPos = useMemo(() => sphericalToXYZ(theta, phi, SPHERE_R), [theta, phi]);
  const beamPoints = useMemo<[number, number, number][]>(
    () => [[0, 0, 0], markerPos],
    [markerPos],
  );

  // zoom(-100~100) → 중앙 이미지 스케일(0.45~1.6). push-in 이면 커지고 pull-back 이면 작아진다.
  const imgScale = useMemo(() => 1 + (clamp(zoom, -100, 100) / 100) * 0.55, [zoom]);

  /** 드래그 상태: 마지막 포인터 좌표 + 시작 시점 각도. */
  const drag = useRef<{ x: number; y: number; theta: number; phi: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 드래그 감도(도/px).
  const SENS = 0.55;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, theta, phi };
      setDragging(true);
    },
    [disabled, theta, phi],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      // 가로 → theta(우로 끌면 +), 세로 위로 끌면 phi 증가(위에서 내려봄).
      const nextTheta = clamp(d.theta + dx * SENS, thetaRange[0], thetaRange[1]);
      const nextPhi = clamp(d.phi - dy * SENS, effPhiRange[0], effPhiRange[1]);
      onChange({ theta: nextTheta, phi: nextPhi });
    },
    [onChange, thetaRange, effPhiRange],
  );
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    drag.current = null;
    setDragging(false);
  }, []);
  const onDoubleClick = useCallback(() => {
    if (disabled) return;
    onChange({ theta: resetTo.theta, phi: resetTo.phi });
  }, [disabled, onChange, resetTo.theta, resetTo.phi]);

  const ringColor = "#6b7280";
  const equatorColor = "#9ca3af";

  const labelStyle: React.CSSProperties = {
    position: "absolute",
    color: "hsl(var(--foreground) / 0.5)",
    fontSize: 9,
    pointerEvents: "none",
    userSelect: "none",
  };

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        touchAction: "none",
        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
        opacity: disabled ? 0.5 : 1,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ position: [0, 0.55, 3.1], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ width: "100%", height: "100%" }}
      >
        <ambientLight intensity={0.85} />
        <directionalLight position={[2, 3, 4]} intensity={1.1} />

        {/* 와이어프레임 구 */}
        {latRings.map((pts, i) => (
          <Line
            key={`lat-${i}`}
            points={pts}
            color={i === 2 ? equatorColor : ringColor}
            lineWidth={i === 2 ? 1.1 : 0.7}
            transparent
            opacity={i === 2 ? 0.5 : 0.28}
          />
        ))}
        {lonRings.map((pts, i) => (
          <Line
            key={`lon-${i}`}
            points={pts}
            color={ringColor}
            lineWidth={0.7}
            transparent
            opacity={0.24}
          />
        ))}

        {/* 중앙 피사체 이미지 */}
        <CenterImage url={imageUrl} scale={imgScale} />

        {/* 마커 → 중앙 빔 */}
        <Line points={beamPoints} color={accentColor} lineWidth={1.4} transparent opacity={0.85} />

        {/* 마커(기즈모) */}
        <MarkerGroup position={markerPos} accentColor={accentColor}>
          {marker}
        </MarkerGroup>
      </Canvas>

      {/* HTML 오버레이 라벨 */}
      {labels?.top && <span style={{ ...labelStyle, top: 2, left: "50%", transform: "translateX(-50%)" }}>{labels.top}</span>}
      {labels?.bottom && (
        <span style={{ ...labelStyle, bottom: 2, left: "50%", transform: "translateX(-50%)" }}>{labels.bottom}</span>
      )}
      {labels?.left && <span style={{ ...labelStyle, left: 2, top: "50%", transform: "translateY(-50%)" }}>{labels.left}</span>}
      {labels?.right && <span style={{ ...labelStyle, right: 2, top: "50%", transform: "translateY(-50%)" }}>{labels.right}</span>}
    </div>
  );
}
