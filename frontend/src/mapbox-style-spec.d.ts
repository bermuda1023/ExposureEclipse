// mapbox-gl ships its style-spec validator untyped under dist/; only the
// validate() entry point is used, by the map-expression tests.
declare module "mapbox-gl/dist/style-spec/index.es.js" {
  export function validate(style: unknown): Array<{ message: string }>;
}
