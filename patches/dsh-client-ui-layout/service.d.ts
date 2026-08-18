/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots';
import type { createLayoutStore } from './stores.ts';
/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>;
/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
    /** Toggle the sidebar panel (closed ⟷ contract default width). */
    toggleSidebar(): void;
    /** Open the details panel (no-op when already open). */
    openDetails(): void;
    /** Close the details panel. */
    closeDetails(): void;
    /** Open the inspector pane (no-op when already open). */
    openInspector(): void;
    /** Close the inspector pane. */
    closeInspector(): void;
    /** Toggle the inspector pane. */
    toggleInspector(): void;
    /** Current inspector open state. */
    isInspectorOpen(): boolean;
    /** Subscribe to inspector open-state changes; returns unsubscribe. */
    onChange(listener: (open: boolean) => void): () => void;
}
/** Cross-plugin panel-action face (ctx.layout). */
export declare class LayoutController implements ILayout {
    #private;
    /**
     * Adopt the root entry's bound store actions. Called from the root
     * registration's inject hook (a sanctioned assembly side effect), so the
     * face is live from the entry's first render; on entry re-register the
     * fresh actions overwrite the stale set.
     * @param actions - bound actions of the entry's layout store instance.
     */
    attachPanels(actions: PanelActions): void;
    /** Toggle the sidebar panel (closed ⟷ contract default width). */
    toggleSidebar(): void;
    /** Open the details panel (no-op when already open). */
    openDetails(): void;
    /** Close the details panel. */
    closeDetails(): void;
    /** Open the inspector pane (no-op when already open). */
    openInspector(): void;
    /** Close the inspector pane. */
    closeInspector(): void;
    /** Toggle the inspector pane. */
    toggleInspector(): void;
    /** Current inspector open state. */
    isInspectorOpen(): boolean;
    /** Subscribe to inspector open-state changes; returns unsubscribe. */
    onChange(listener: (open: boolean) => void): () => void;
}
//# sourceMappingURL=service.d.ts.map