export default function ImageViewer({ src, name }: { src: string; name: string }) {
	return (
		<div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
			<img data-testid="preview-image" src={src} alt={name} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
		</div>
	);
}
