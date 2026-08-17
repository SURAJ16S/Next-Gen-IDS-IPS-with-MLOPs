# Self-Healing Build Agent - Few-Shot Prompt Alignment Examples

These examples illustrate the expected XML output formatting `<patch file="...">...</patch>` for the model. Use these few-shots in prompts to align healing output templates.

---

## Example 1: TypeScript Overload Match Error (TS2769)

### Error Input
```text
[COMPILE/BUILD] [STDERR] src/controllers/blogController.ts(742,42): error TS2769: No overload matches this call.
[COMPILE/BUILD] [STDERR]   The last overload gave the following error.
[COMPILE/BUILD] [STDERR]     Argument of type '{ author: string; status: string; }' is not assignable to parameter of type 'FilterQuery<IBlog>'.
```

### Healed Output Patch
```xml
<patch file="src/controllers/blogController.ts">
import { Request, Response } from 'express';
import Blog from '../models/Blog';

export const getBlogsByAuthor = async (req: Request, res: Response) => {
  try {
    // Cast query variables to any to avoid Mongoose type matching overloads
    const filterQuery: any = {
      author: String(req.query.author),
      status: 'active'
    };
    const blogs = await Blog.find(filterQuery);
    return res.json(blogs);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
</patch>
```

---

## Example 2: Express 5 Routing Path Parameter Error

### Error Input
```text
[COMPILE/BUILD] [STDERR] /workspace/server.js:15
[COMPILE/BUILD] [STDERR] app.get('/api/v1/files/*', fileHandler);
[COMPILE/BUILD] [STDERR]                       ^
[COMPILE/BUILD] [STDERR] Error: Missing parameter name at index 16
[COMPILE/BUILD] [STDERR]     at parse (/workspace/node_modules/path-to-regexp/index.js:93:12)
```

### Healed Output Patch
```xml
<patch file="server.js">
const express = require('express');
const app = express();

const fileHandler = (req, res) => {
  res.json({ status: "file fetched" });
};

// Express 5 routing fix: name the wildcard parameter
app.get('/api/v1/files/*wildcard', fileHandler);

app.listen(process.env.PORT || 3000);
</patch>
```

---

## Example 3: Missing package.json Dependencies

### Error Input
```text
[COMPILE/BUILD] [STDERR] Error: Cannot find module 'bcryptjs'
[COMPILE/BUILD] [STDERR]     at Module._resolveFilename (node:internal/modules/cjs/loader:1249:15)
```

### Healed Output Patch
```xml
<patch file="package.json">
{
  "name": "healed-mern-app",
  "version": "1.0.0",
  "dependencies": {
    "express": "^5.0.0",
    "mongoose": "^8.0.0",
    "bcryptjs": "^2.4.3"
  }
}
</patch>
```
