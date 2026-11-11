import { Bot, Workflow } from "lucide-react";
import type { FileOrigin } from "@shared/files";

export const ORIGIN: Record<FileOrigin, { label: string; icon?: typeof Bot }> = {
	upload: { label: "上传" },
	agent: { label: "助手生成", icon: Bot },
	automation: { label: "自动化", icon: Workflow },
};
