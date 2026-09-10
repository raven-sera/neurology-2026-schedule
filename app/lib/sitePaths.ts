// Next Link/router add this prefix automatically; public assets need it explicitly.
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');

export function publicPath(path: string): string {
  return BASE_PATH + (path.startsWith('/') ? path : '/' + path);
}

export function localPathname(pathname: string, basePath = BASE_PATH): string {
  const local = basePath && (pathname === basePath || pathname.startsWith(basePath + '/'))
    ? pathname.slice(basePath.length) : pathname;
  return local.replace(/\/+$/, '') || '/';
}
