/** Scheduled, bounded reconciler for durable project asset-deletion tombstones. */
import { drainProjectAssetDeletionQueue } from "@/lib/project-asset-deletion";
import { drainProjectAssetObjectEvents } from "@/lib/project-asset-object-events";
import { drainLabelStudioProjectIntentQueue } from "@/lib/label-studio-project-intent";
import { drainLabelStudioSessionRetirementQueue } from "@/lib/label-studio-session-retirement";

async function main(): Promise<void> {
  // Final/staging ObjectCreated events reopen terminal tombstones before the due-row drain begins.
  const events = await drainProjectAssetObjectEvents();
  const [assets, labelStudio, labelStudioRetirements] = await Promise.all([
    drainProjectAssetDeletionQueue(),
    drainLabelStudioProjectIntentQueue(),
    drainLabelStudioSessionRetirementQueue(),
  ]);
  console.log("[project-asset-deletion-worker] complete", {
    assets,
    events,
    labelStudio,
    labelStudioRetirements,
  });
  if (
    events.failed > 0 ||
    assets.failed > 0 ||
    labelStudio.failed > 0 ||
    labelStudioRetirements.failed > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[project-asset-deletion-worker] fatal", error);
  process.exitCode = 1;
});
