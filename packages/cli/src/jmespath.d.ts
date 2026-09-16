import "jmespath";

// The upstream declarations omit this export from the installed runtime.
declare module "jmespath" {
  export function compile(expression: string): unknown;
}
