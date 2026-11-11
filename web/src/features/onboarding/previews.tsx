// The calm, CSS-only pictures in the left column of the onboarding dialog (styles in onboarding.css). Purely decorative:
// the column is aria-hidden and hidden on phones; the text on the right carries all the information.
import { BookOpen, Check, FileText, MessageSquare, ShieldCheck } from "lucide-react";

export type SceneId = "welcome" | "appearance" | "security" | "done";

function Welcome() {
	return (
		<div className="ob-w">
			<div className="ob-w-ask ob-r1">
				<span className="ob-bar" style={{ width: "92%" }} />
				<span className="ob-bar" style={{ width: "60%" }} />
			</div>
			<div className="ob-card ob-w-steps ob-r2">
				{[70, 52, 62].map((w, i) => (
					<div key={i} className="ob-w-step">
						<span className="ob-w-tick">
							<Check strokeWidth={3} />
						</span>
						<span className="ob-bar ob-bar-strong" style={{ width: `${w}%` }} />
					</div>
				))}
			</div>
			<div className="ob-card ob-w-file ob-r4">
				<span className="ob-w-file-icon">
					<FileText />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="ob-bar ob-bar-strong" style={{ width: "74%" }} />
					<span className="ob-bar" style={{ width: "40%" }} />
				</span>
			</div>
		</div>
	);
}

function Appearance({ dots }: { dots: boolean }) {
	return (
		<>
			{dots ? <span className="ob-dots" /> : null}
			<div className="ob-card ob-win">
				<div className="ob-win-side">
					<span className="ob-bar ob-bar-strong" style={{ width: "100%" }} />
					<span className="ob-bar" style={{ width: "80%" }} />
					<span className="ob-bar" style={{ width: "90%" }} />
					<span className="ob-bar" style={{ width: "64%" }} />
				</div>
				<div className="ob-win-main">
					<div className="flex flex-col gap-2">
						<span className="ob-bar ob-bar-strong" style={{ width: "58%" }} />
						<span className="ob-bar" style={{ width: "86%" }} />
						<span className="ob-bar" style={{ width: "72%" }} />
					</div>
					<div className="ob-win-composer">
						<span className="ob-win-send" />
					</div>
				</div>
			</div>
		</>
	);
}

function Security() {
	return (
		<div className="ob-s">
			<span className="ob-s-shield">
				<ShieldCheck />
			</span>
			<div className="ob-card ob-s-code">
				<span className="ob-s-digits">482 913</span>
				<span className="ob-s-digits">075 396</span>
				<span className="ob-s-timer">
					<span />
				</span>
			</div>
		</div>
	);
}

function Done() {
	return (
		<div className="ob-d">
			<svg className="ob-d-check" viewBox="0 0 64 64">
				<circle cx="32" cy="32" r="24" />
				<path d="M22 33l7 7 14-15" />
			</svg>
			<div className="ob-d-chips">
				<div className="ob-card ob-d-chip">
					<MessageSquare />
					对话
				</div>
				<div className="ob-card ob-d-chip">
					<FileText />
					文件库
				</div>
				<div className="ob-card ob-d-chip">
					<BookOpen />
					知识库
				</div>
			</div>
		</div>
	);
}

export function Scene({ id, dots }: { id: SceneId; dots: boolean }) {
	return (
		<div data-testid="onboarding-preview" data-scene={id} aria-hidden className="ob-scene">
			{id === "welcome" ? <Welcome /> : id === "appearance" ? <Appearance dots={dots} /> : id === "security" ? <Security /> : <Done />}
		</div>
	);
}
