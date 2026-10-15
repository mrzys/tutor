import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

export const WorkbenchHeaderActionsContext = createContext(null);

export function WorkbenchHeaderActions({ children }) {
  const target = useContext(WorkbenchHeaderActionsContext);
  return target ? createPortal(children, target) : null;
}
