import { defineRoute } from "@/server/api/defineRoute";
import {
  serveLabelStudioAsset,
  withLabelStudioAssetResponsePolicy,
} from "@/lib/label-studio-asset-grant";

const getLabelStudioAsset = defineRoute({
  auth: "none",
  kind: "raw",
  handler: ({ req, params }) =>
    serveLabelStudioAsset(
      req,
      params.id,
      new URL(req.url).searchParams.get("token"),
    ),
});

const headLabelStudioAsset = defineRoute({
  auth: "none",
  kind: "raw",
  handler: ({ req, params }) =>
    serveLabelStudioAsset(
      req,
      params.id,
      new URL(req.url).searchParams.get("token"),
      true,
    ),
});

export const GET: typeof getLabelStudioAsset = async (req, segment) =>
  withLabelStudioAssetResponsePolicy(
    req,
    await getLabelStudioAsset(req, segment),
  );

export const HEAD: typeof headLabelStudioAsset = async (req, segment) => {
  const response = await headLabelStudioAsset(req, segment);
  return withLabelStudioAssetResponsePolicy(
    req,
    new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
};

export async function OPTIONS(req: Request): Promise<Response> {
  return withLabelStudioAssetResponsePolicy(
    req,
    new Response(null, { status: 204 }),
  );
}
