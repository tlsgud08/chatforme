import type { ReactNode } from 'react';

export default function ModernPageHeading({ title, description, children }: {
  title: string; description?: string; children?: ReactNode;
}) {
  return <div className="modern-page-heading modern-only">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children}
  </div>;
}
