/**
 * 匹配路由 pattern 到实际请求路径。
 *
 * pattern 支持 `:param` 段（如 `/sessions/:id/model`），静态路径退化为精确匹配。
 * 返回匹配到的路径参数（原始 segment，未做 URI 解码）；不匹配返回 null。
 */
export function matchRoutePath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (patternSegment.startsWith(":")) {
      if (pathSegment === "") return null;
      params[patternSegment.slice(1)] = pathSegment;
    } else if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}
