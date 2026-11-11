import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { Notice, PanelLoading } from "@/features/work/states";

export default function ImageViewer({ src, name }: { src: string; name: string }) {
	const [state, setState] = useState<"loading" | "ok" | "error">("loading");
	useEffect(() => setState("loading"), [src]);
	if (state === "error") return <Notice tone="danger" icon={<ImageOff />} title="图片无法显示" />;
	return (
		<div className="relative flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
			<img data-testid="preview-image" src={src} alt={name} onLoad={() => setState("ok")} onError={() => setState("error")} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
			{state === "loading" ? (
				<div className="absolute inset-0 bg-surface-2">
					<PanelLoading />
				</div>
			) : null}
		</div>
	);
}
