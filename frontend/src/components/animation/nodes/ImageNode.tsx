import AssetLayerCard from "./AssetLayerCard";
import { IMAGE_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";

// Image source: an uploaded still placed into a normalized box and scaled to `fit`, output
// as video (→ a stack combine or an output). The upload zone POSTs the file to
// /upload-asset/<job> (via useAssetUpload) and stores the served URL in `data.assetUrl`.
// The box + fit are static; `opacity` is the only modulatable port. All of that is the
// shared AssetLayerCard shell — the image card is just its "image" configuration.
export default function ImageNode(props: NodeProps) {
  return (
    <AssetLayerCard
      {...props}
      kind="image"
      accept="image/*"
      dropIcon="🖼"
      dropEmptyLabel="drop an image"
      dropBusyLabel="uploading…"
      dropThumb
      params={IMAGE_PARAMS}
    />
  );
}
