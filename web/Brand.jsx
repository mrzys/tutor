import React from 'react';
import './Brand.css';

export function Brand({ className = '' }) {
  return <span className={`brand zhijiao-brand ${className}`}>
    <img src="/zhijiao-icon.svg" className="zhijiao-brand-icon" width="28" height="28" alt="" aria-hidden="true"/>
    <span>智教</span>
  </span>;
}
