const AuroraBackground = () => {
  return (
    <div
      className="pointer-events-none"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        overflow: "hidden",
      }}
    >
      {/* Top: dark cool tone */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "-10%",
          right: "-10%",
          height: "55%",
          background: "radial-gradient(ellipse 120% 80% at 50% 0%, rgba(160,165,180,0.12) 0%, rgba(120,125,140,0.06) 40%, transparent 70%)",
          filter: "blur(40px)",
          animation: "auroraTop 30s ease-in-out infinite",
          willChange: "transform",
        }}
      />
      {/* Bottom: KR Red warm glow */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "-10%",
          right: "-10%",
          height: "55%",
          background: "radial-gradient(ellipse 120% 80% at 50% 100%, rgba(180,180,190,0.10) 0%, rgba(150,150,160,0.04) 40%, transparent 70%)",
          filter: "blur(50px)",
          animation: "auroraBottom 35s ease-in-out infinite",
          willChange: "transform",
        }}
      />
      {/* Mid blend layer */}
      <div
        style={{
          position: "absolute",
          top: "30%",
          left: "-5%",
          right: "-5%",
          height: "40%",
          background: "radial-gradient(ellipse 100% 60% at 50% 50%, rgba(170,160,175,0.06) 0%, transparent 70%)",
          filter: "blur(60px)",
          animation: "auroraMid 25s ease-in-out infinite",
          willChange: "transform",
        }}
      />
      {/* Noise texture */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.015,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />
    </div>
  );
};

export default AuroraBackground;
