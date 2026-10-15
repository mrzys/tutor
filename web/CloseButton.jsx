import React from 'react';
import { X } from 'lucide-react';
import './CloseButton.css';

export function CloseButton({ label = '关闭', className = '', ...props }) {
  return <button {...props} type="button" className={`ui-close-button ${className}`.trim()} aria-label={label} title={label}>
    <X size={18} aria-hidden="true"/>
  </button>;
}
