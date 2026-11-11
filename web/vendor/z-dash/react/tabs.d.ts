/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Tabs> (react/tabs.js). */
import type * as React from 'react';
import type { Density, DsEventProps, Shape, Size } from './shared.js';
import type { TabsChange, create } from '../js/tabs.js';

export type TabsVariant = 'line' | 'contained' | 'fill' | 'flush' | 'vertical';

export interface TabItem {
  /** Unique in the row: the value of onChange and value. */
  key: string;
  label: React.ReactNode;
  /** The panel's content (rendered the first time it shows, unless lazy is false). */
  panel?: React.ReactNode;
  /** A .ds-tabs__count after the label. */
  count?: React.ReactNode;
  /** A glyph of js/icons.js or a node. */
  icon?: string | React.ReactNode;
  /** aria-disabled: it takes the focus, never the selection. */
  disabled?: boolean;
  /** A close button, Delete, and a close action in its panel: onClose. */
  closable?: boolean;
}

export type TabsProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'onChange' | 'defaultValue'> & DsEventProps & {
  items: TabItem[];
  /** The row's accessible name (or aria-labelledby). */
  label?: string;
  /** The selected key: a change selects that tab. */
  value?: string | null;
  defaultValue?: string;
  /** The user selected a tab. */
  onChange?: (key: string, detail: TabsChange) => void;
  variant?: TabsVariant | TabsVariant[];
  /** Tabs that do not fit go into a More menu. */
  overflow?: boolean;
  /** 'manual': the arrow keys move the focus, Enter or Space selects. */
  activate?: 'focus' | 'manual';
  /** A closable tab is closed by the user: remove its item (its neighbour is selected already). */
  onClose?: (key: string, detail: { tab: HTMLElement; panel: HTMLElement | null }) => void;
  /** An add button at the end of the bar: add an item. */
  onAdd?: (detail: unknown) => void;
  /** The add button's name (required with onAdd). */
  addLabel?: string;
  /** Render a panel's content the first time it shows (default true). */
  lazy?: boolean;
  panelClassName?: string;
  size?: Size;
  density?: Density;
  shape?: Shape;
  touch?: boolean;
  /** Receives DS.tabs' controller. */
  controllerRef?: React.Ref<ReturnType<typeof create> | null>;
  className?: string;
};

export declare const Tabs: React.ForwardRefExoticComponent<TabsProps & React.RefAttributes<HTMLDivElement>>;
