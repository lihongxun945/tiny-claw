declare module "bash-parser" {
  export default function parse(source: string, options?: { insertLOC?: boolean }): unknown;
}
