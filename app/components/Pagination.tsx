"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";

/** Client-side pagination state + a stable, clamped current page. */
export function usePaged<T>(items: T[], pageSize = 8) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  // Keep the page in range when the underlying list shrinks.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const visible = useMemo(
    () => items.slice(page * pageSize, page * pageSize + pageSize),
    [items, page, pageSize]
  );

  return { page, setPage, pageCount, visible };
}

export function Pagination({
  page,
  pageCount,
  setPage,
  t
}: {
  page: number;
  pageCount: number;
  setPage: (n: number) => void;
  t: any;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button className="ghost sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
        <Icon name="generate" /> {t.prevPage}
      </button>
      <span className="pager-info">
        {t.pageLabel} {page + 1} {t.ofLabel} {pageCount}
      </span>
      <button
        className="ghost sm"
        onClick={() => setPage(Math.min(pageCount - 1, page + 1))}
        disabled={page >= pageCount - 1}
      >
        {t.nextPage} <Icon name="generate" />
      </button>
    </div>
  );
}
