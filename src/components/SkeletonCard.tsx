export const SkeletonCard = () => (
  <div className="bg-card border border-border" style={{ borderRadius: 0 }}>
    <div className="aspect-video w-full skeleton-shimmer" style={{ borderRadius: 0 }} />
    <div className="space-y-2 px-3 py-2.5">
      <div className="h-4 w-2/3 skeleton-shimmer" style={{ borderRadius: 0 }} />
      <div className="h-[2px] w-full skeleton-shimmer" style={{ borderRadius: 0 }} />
      <div className="flex gap-1.5">
        <div className="h-5 w-16 skeleton-shimmer" style={{ borderRadius: 0 }} />
        <div className="h-5 w-20 skeleton-shimmer" style={{ borderRadius: 0 }} />
      </div>
    </div>
  </div>
);
