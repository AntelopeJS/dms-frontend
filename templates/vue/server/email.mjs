import { body } from "./auth/backend.mjs";
import { validRenderToken } from "./render-token.mjs";

const JSON_TYPE = "application/json";

/** Renders an email template for an authenticated backend request. */
export async function handleEmailRender(request, response) {
  if (!validRenderToken(request.headers["x-dms-service-token"])) {
    response.writeHead(401, { "content-type": JSON_TYPE });
    return response.end(JSON.stringify({ message: "Invalid service token" }));
  }
  const input = await body(request);
  if (
    typeof input.templateName !== "string" ||
    input.templateName.trim() === "" ||
    typeof input.props !== "object"
  ) {
    response.writeHead(400, { "content-type": JSON_TYPE });
    return response.end(JSON.stringify({ message: "Invalid request body" }));
  }
  try {
    const { renderEmail } = await import("../dist/server/email-renderer.js");
    const html = await renderEmail(input.templateName, input.props ?? {}, {
      locale: request.headers["x-content-language"],
    });
    response.writeHead(200, { "content-type": JSON_TYPE });
    response.end(JSON.stringify({ html }));
  } catch {
    response.writeHead(404, { "content-type": JSON_TYPE });
    response.end(
      JSON.stringify({
        message: `Template "${input.templateName}" not found or render failed`,
      }),
    );
  }
}
