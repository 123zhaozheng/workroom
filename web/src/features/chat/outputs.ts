// The conversation's delivered outputs (state.work.outputs, active and removed) by fileId. File cards resolve through it, so a card in an
// old message always shows the CURRENT file (an overwrite keeps the fileId) and a withdrawn one shows 已删除.
import { createContext, useContext } from "react";
import type { LibItemDTO } from "@shared/files";

export const OutputsContext = createContext<ReadonlyMap<string, LibItemDTO>>(new Map());
export const useOutputs = () => useContext(OutputsContext);

export function outputsMap(outputs: readonly LibItemDTO[] | undefined): Map<string, LibItemDTO> {
	return new Map((outputs ?? []).map((o) => [o.fileId, o]));
}
