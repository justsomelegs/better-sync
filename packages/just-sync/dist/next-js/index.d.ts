declare function toNextJsHandler(handler: (req: Request) => Promise<Response>): {
    readonly GET: (req: Request) => Promise<Response>;
    readonly POST: (req: Request) => Promise<Response>;
};

export { toNextJsHandler };
