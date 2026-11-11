// Popover Select on the Radix Select primitive. Drop-in for the old native <Select>: the same <option> children, the same
// `value` / `onChange(e)` (e.target.value is the option's value) so every call site keeps its meaning.
//   <Select aria-label="范围" value={v} onChange={(e) => set(e.target.value)}>
//     <option value="a">甲</option>
//     <SelectOption value="b" description="一行说明">乙</SelectOption>   // optional subtitle line
//   </Select>
// Look (docs/design-guidelines.md): rounded-full light-grey trigger with a chevron; opaque rounded-xl popover with shadow-pop;
// roomy items, a check on the right for the current one; scrolls when long and flips at the viewport edge. Keyboard: arrows /
// Home / End / typeahead / Enter / Escape (focus goes back to the trigger) all come from Radix.
// An accessible name is required: aria-label, aria-labelledby, or an `id` that a <label htmlFor> points at.
import { Check, ChevronDown } from "lucide-react";
import { Select as S } from "radix-ui";
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Radix rejects "" as an item value (it means "no selection"); an empty-valued option travels under this key. */
const EMPTY = "__wr_empty__";

export interface SelectOptionProps {
	value: string;
	disabled?: boolean;
	/** Second, muted line under the label. */
	description?: ReactNode;
	children?: ReactNode;
}
/** Option with a description line. Plain <option> works too (no description). Never rendered itself. */
export function SelectOption(_: SelectOptionProps): null {
	return null;
}

interface Opt {
	value: string;
	label: ReactNode;
	text: string;
	description?: ReactNode;
	disabled?: boolean;
	group?: string;
}
const textOf = (n: ReactNode): string => (Array.isArray(n) ? n.map(textOf).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : "");

function collect(children: ReactNode, group?: string, out: Opt[] = []): Opt[] {
	Children.forEach(children, (c) => {
		if (!isValidElement(c)) return;
		const el = c as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
		if (el.type === Fragment) collect(el.props.children, group, out);
		else if (el.type === "optgroup") collect(el.props.children, String(el.props.label ?? ""), out);
		else if (el.type === "option" || el.type === SelectOption) {
			const label = el.props.children;
			const value = el.props.value !== undefined ? String(el.props.value) : textOf(label);
			out.push({ value, label, text: textOf(label), description: el.props.description as ReactNode, disabled: !!el.props.disabled, group });
		}
	});
	return out;
}

type Named = { "aria-label": string; "aria-labelledby"?: string; id?: string } | { "aria-labelledby": string; "aria-label"?: string; id?: string } | { id: string; "aria-label"?: string; "aria-labelledby"?: string };
export type SelectProps = Named & {
	value: string | number;
	onChange?: (e: { target: { value: string }; currentTarget: { value: string } }) => void;
	children?: ReactNode;
	className?: string;
	disabled?: boolean;
	placeholder?: string;
	name?: string;
	required?: boolean;
	/** Class for the popover (e.g. a wider min-width). */
	contentClassName?: string;
	"data-testid"?: string;
};

export function Select({ value: rawValue, onChange, children, className, contentClassName, disabled, placeholder = "请选择", name, required, ...rest }: SelectProps) {
	const value = String(rawValue);
	const opts = collect(children);
	const hasEmpty = opts.some((o) => o.value === "");
	const v = value === "" ? (hasEmpty ? EMPTY : "") : value;
	const groups = [...new Set(opts.map((o) => o.group))];
	const current = opts.find((o) => o.value === value);
	return (
		<S.Root value={v} onValueChange={(nv) => ((nv = nv === EMPTY ? "" : nv), onChange?.({ target: { value: nv }, currentTarget: { value: nv } }))} disabled={disabled} name={name} required={required}>
			<S.Trigger
				{...rest}
				data-wr-select=""
				data-value={value}
				className={cn(
					"inline-flex h-9 min-w-0 max-w-full items-center justify-between gap-2 rounded-full bg-surface-2 pl-3.5 pr-2.5 text-left text-sm text-fg outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:bg-surface-3 data-[placeholder]:text-fg-subtle",
					className,
				)}
			>
				<span className="min-w-0 flex-1 truncate">
					<S.Value placeholder={placeholder}>{current ? current.text : undefined}</S.Value>
				</span>
				<S.Icon asChild>
					<ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
				</S.Icon>
			</S.Trigger>
			<S.Portal>
				<S.Content
					position="popper"
					sideOffset={6}
					collisionPadding={{ top: 64, bottom: 12, left: 12, right: 12 }}
					className={cn(
						"z-[70] max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[max(var(--radix-select-trigger-width),12rem)] max-w-[min(26rem,calc(100vw-24px))] overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-pop wr-fade-in",
						contentClassName,
					)}
				>
					<S.Viewport className="max-h-[inherit] overflow-y-auto p-1.5">
						{groups.map((g) => (
							<S.Group key={g ?? ""}>
								{g ? <S.Label className="px-3 pb-1 pt-2 text-xs text-fg-subtle">{g}</S.Label> : null}
								{opts
									.filter((o) => o.group === g)
									.map((o) => (
										<S.Item
											key={o.value}
											value={o.value === "" ? EMPTY : o.value}
											disabled={o.disabled}
											textValue={o.text}
											data-value={o.value}
											data-label={o.text}
											className="relative flex cursor-default select-none items-center rounded-xl py-2 pl-3 pr-9 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2"
										>
											<span className="min-w-0">
												<S.ItemText>{o.label}</S.ItemText>
												{o.description ? <span className="mt-0.5 block text-xs text-fg-muted">{o.description}</span> : null}
											</span>
											<S.ItemIndicator className="absolute right-3 inline-flex items-center">
												<Check aria-hidden className="size-4" />
											</S.ItemIndicator>
										</S.Item>
									))}
							</S.Group>
						))}
					</S.Viewport>
				</S.Content>
			</S.Portal>
		</S.Root>
	);
}
