import { z } from "zod";
export declare const schema: {
    readonly todos: z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        done: z.ZodDefault<z.ZodBoolean>;
        updatedAt: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        done: boolean;
        updatedAt: number;
    }, {
        id: string;
        title: string;
        updatedAt: number;
        done?: boolean | undefined;
    }>;
};
