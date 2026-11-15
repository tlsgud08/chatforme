import { createLocalProxy } from './handler.ts';

Deno.serve(createLocalProxy(name => Deno.env.get(name)));
