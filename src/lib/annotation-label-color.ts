import { TWENTY_COLORS } from "@/types";

export function annotationLabelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}
