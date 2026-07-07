// Preview tier (#61): marks a field/section/row that needs the local
// build (BYOK credentials or the local sidecar) — rendered next to a
// disabled affordance rather than hiding it (showroom posture: show
// everything, no dead ends). Shared between SettingsDialog.tsx and
// HistoryDrawer.tsx — both grey out sidecar-dependent affordances the
// same way. Terminal aesthetic: square corners, muted border/text, no
// bright colors.
export default function PreviewLockedBadge() {
  return (
    <span className="rounded-sm border border-edge px-1.5 py-0.5 text-[10px] text-mut2 whitespace-nowrap">
      本地版功能
    </span>
  );
}
