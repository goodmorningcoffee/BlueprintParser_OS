/**
 * Generates Label Studio XML labeling configuration from task type and labels.
 * Pure function — no dependencies, easy to test.
 *
 * @see https://labelstud.io/tags/rectanglelabels
 * @see https://labelstud.io/tags/choices
 * @see https://labelstud.io/tags/polygonlabels
 * @see https://labelstud.io/tags/textarea
 */

export type LabelingTaskType = "detection" | "classification" | "segmentation" | "text";

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function generateLabelConfig(taskType: LabelingTaskType, labels: string[]): string {
  const safeLabels = labels.map((l) => l.trim()).filter(Boolean);

  switch (taskType) {
    case "detection":
      return [
        "<View>",
        '  <Image name="image" value="$image" zoomControl="true" rotateControl="false"/>',
        '  <RectangleLabels name="labels" toName="image">',
        ...safeLabels.map((l) => `    <Label value="${escapeXml(l)}"/>`),
        "  </RectangleLabels>",
        "</View>",
      ].join("\n");

    case "classification":
      return [
        "<View>",
        '  <Image name="image" value="$image" zoomControl="true"/>',
        '  <Choices name="classes" toName="image" choice="single">',
        ...safeLabels.map((l) => `    <Choice value="${escapeXml(l)}"/>`),
        "  </Choices>",
        "</View>",
      ].join("\n");

    case "segmentation":
      return [
        "<View>",
        '  <Image name="image" value="$image" zoomControl="true"/>',
        '  <PolygonLabels name="labels" toName="image">',
        ...safeLabels.map((l) => `    <Label value="${escapeXml(l)}"/>`),
        "  </PolygonLabels>",
        "</View>",
      ].join("\n");

    case "text":
      return [
        "<View>",
        '  <Image name="image" value="$image" zoomControl="true"/>',
        '  <TextArea name="text" toName="image" editable="true" rows="3" maxSubmissions="1"/>',
        "</View>",
      ].join("\n");

    default:
      throw new Error(`Unknown task type: ${taskType}`);
  }
}
