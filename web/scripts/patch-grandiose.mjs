import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Patches grandiose so it builds against modern MSVC AND so it exposes
// `sender.audio(...)` for NDI audio sending.
//
// 1. grandiose_util.h / .cc: change `char* file` and `char* methodName` to
//    `const char*` so the macros (REJECT_STATUS, etc.) compile under
//    modern MSVC C++17 conformance (rejects implicit string-literal ->
//    char* conversion).
// 2. binding.gyp: add `/permissive` + `/Zc:strictStrings-` MSVC flags as
//    a safety net.
// 3. grandiose_send.cc: enable `sender.audio()`.
//      - The upstream master leaves the audio code path commented out
//        (`// napi_value audioFn; ...`) and never declares / defines the
//        `audioSend` C++ entry point. We:
//          a. Replace the commented-out block in `sendComplete()` with
//             active code that registers the `audio` property on the
//             returned sender object.
//          b. Append a forward declaration + full `audioSend` /
//             `audioSendExecute` / `audioSendComplete` implementation
//             at the end of the file. The carrier struct
//             (`sendDataCarrier::audioFrame`) is already declared in
//             `grandiose_send.h`, so no header change is needed.
//      - The patched `audioSend` accepts the JS shape
//        `{ sampleRate, numChannels, numSamples, channelStrideInBytes,
//          data: Buffer }` where `data` is planar Float32 (channel 0
//        followed by channel 1, etc., each `numSamples * 4` bytes long
//        for FLTP). Calls `NDIlib_send_send_audio_v2`.
//
// Idempotent: each step checks for a sentinel before patching, so the
// script is safe to run on every `npm install`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grandioseDir = path.join(__dirname, "..", "node_modules", "grandiose");

if (!fs.existsSync(grandioseDir)) {
  process.stdout.write("[patch-grandiose] node_modules/grandiose not present; nothing to patch.\n");
  process.exit(0);
}

const utilHeader = path.join(grandioseDir, "src", "grandiose_util.h");
const utilImpl = path.join(grandioseDir, "src", "grandiose_util.cc");
const sendImpl = path.join(grandioseDir, "src", "grandiose_send.cc");
const bindingGyp = path.join(grandioseDir, "binding.gyp");

let touched = false;

function rewrite(filePath, replacements) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, "utf8");
  let next = original;
  for (const { from, to } of replacements) {
    if (next.includes(from)) {
      next = next.replaceAll(from, to);
    }
  }
  if (next !== original) {
    fs.writeFileSync(filePath, next, "utf8");
    return true;
  }
  return false;
}

const headerChanged = rewrite(utilHeader, [
  {
    from: "napi_status checkArgs(napi_env env, napi_callback_info info, char* methodName,",
    to: "napi_status checkArgs(napi_env env, napi_callback_info info, const char* methodName,",
  },
  {
    from: "int32_t rejectStatus(napi_env env, carrier* c, char* file, int32_t line);",
    to: "int32_t rejectStatus(napi_env env, carrier* c, const char* file, int32_t line);",
  },
]);
if (headerChanged) {
  process.stdout.write("[patch-grandiose] Patched src/grandiose_util.h\n");
  touched = true;
}

const implChanged = rewrite(utilImpl, [
  {
    from: "napi_status checkArgs(napi_env env, napi_callback_info info, char* methodName,",
    to: "napi_status checkArgs(napi_env env, napi_callback_info info, const char* methodName,",
  },
  {
    from: "int32_t rejectStatus(napi_env env, carrier* c, char* file, int32_t line) {",
    to: "int32_t rejectStatus(napi_env env, carrier* c, const char* file, int32_t line) {",
  },
]);
if (implChanged) {
  process.stdout.write("[patch-grandiose] Patched src/grandiose_util.cc\n");
  touched = true;
}

/**
 * Step 3: enable `sender.audio()` in grandiose_send.cc.
 *
 * The upstream comment-block sentinel is the four `//` lines that start
 * with `// napi_value audioFn;`. We replace those with active code AND
 * append the audioSend implementation at the bottom of the file (with
 * its own sentinel `MATBEAST_AUDIO_SEND_PATCH_V1`). Both checks below
 * are idempotent — running the script repeatedly leaves the patched
 * file unchanged.
 */
const AUDIO_PATCH_SENTINEL = "// MATBEAST_AUDIO_SEND_PATCH_V1";
if (fs.existsSync(sendImpl)) {
  const original = fs.readFileSync(sendImpl, "utf8");
  let next = original;

  /**
   * Match the commented audio-function-registration block with a regex
   * that's tolerant of both LF and CRLF line endings AND of varying
   * whitespace inside the comment lines. Upstream master ships with
   * CRLF on Windows after `npm install`, which silently breaks plain
   * string `replaceAll` matching.
   */
  const commentedAudioRegex =
    /\/\/\s*napi_value\s+audioFn;\s*\r?\n\s*\/\/\s*c->status\s*=\s*napi_create_function\(env,\s*"audio",\s*NAPI_AUTO_LENGTH,\s*audioSend,\s*\r?\n\s*\/\/\s*nullptr,\s*&audioFn\);\s*\r?\n\s*\/\/\s*REJECT_STATUS;\s*\r?\n\s*\/\/\s*c->status\s*=\s*napi_set_named_property\(env,\s*result,\s*"audio",\s*audioFn\);\s*\r?\n\s*\/\/\s*REJECT_STATUS;/;
  const enabledAudioBlock =
    "napi_value audioFn;\n" +
    '  c->status = napi_create_function(env, "audio", NAPI_AUTO_LENGTH, audioSend,\n' +
    "    nullptr, &audioFn);\n" +
    "  REJECT_STATUS;\n" +
    '  c->status = napi_set_named_property(env, result, "audio", audioFn);\n' +
    "  REJECT_STATUS;";

  if (commentedAudioRegex.test(next)) {
    next = next.replace(commentedAudioRegex, enabledAudioBlock);
    process.stdout.write(
      "[patch-grandiose] Enabled audio function registration in src/grandiose_send.cc\n",
    );
  }

  /**
   * Forward declaration of audioSend, inserted right after the existing
   * videoSend forward decl. We anchor on the unique videoSend prototype
   * so we don't accidentally double-insert.
   */
  const videoFwd = "napi_value videoSend(napi_env env, napi_callback_info info);";
  const audioFwd = "napi_value audioSend(napi_env env, napi_callback_info info);";
  if (next.includes(videoFwd) && !next.includes(audioFwd)) {
    next = next.replace(videoFwd, `${videoFwd}\n${audioFwd}`);
    process.stdout.write(
      "[patch-grandiose] Added audioSend forward declaration\n",
    );
  }

  /**
   * Append the audioSend implementation. The block is wrapped between
   * sentinel comments so a future rerun of the patch script can detect
   * it and skip. Uses the existing `sendDataCarrier::audioFrame` slot
   * (already declared in grandiose_send.h) and the existing
   * REJECT_STATUS / REJECT_RETURN / REJECT_ERROR_RETURN macros.
   *
   * JS frame shape:
   *   {
   *     sampleRate:           48000,
   *     numChannels:          2,
   *     numSamples:           1024,
   *     channelStrideInBytes: 4096,    // numSamples * sizeof(float)
   *     data:                 Buffer   // planar float32, length = numChannels * channelStrideInBytes
   *   }
   *
   * Returns a Promise that resolves to {} once NDI accepts the frame.
   * Rejects on any napi error or if the buffer is missing / wrong type.
   */
  if (!next.includes(AUDIO_PATCH_SENTINEL)) {
    const audioImpl =
      "\n" +
      `${AUDIO_PATCH_SENTINEL} BEGIN — added by matbeastscore postinstall (v0.9.34).\n` +
      "// Implements sender.audio({ sampleRate, numChannels, numSamples, channelStrideInBytes, data:Buffer })\n" +
      "// for NDI planar Float32 (FLTP) audio. The upstream master leaves this commented out;\n" +
      "// we enable it without modifying any header (relies on existing sendDataCarrier::audioFrame).\n" +
      "void audioSendExecute(napi_env env, void* data) {\n" +
      "  sendDataCarrier* c = (sendDataCarrier*) data;\n" +
      "  NDIlib_send_send_audio_v2(c->send, &c->audioFrame);\n" +
      "}\n" +
      "\n" +
      "void audioSendComplete(napi_env env, napi_status asyncStatus, void* data) {\n" +
      "  sendDataCarrier* c = (sendDataCarrier*) data;\n" +
      "  napi_value result;\n" +
      "  napi_status status;\n" +
      "  c->status = napi_delete_reference(env, c->sourceBufferRef);\n" +
      "  REJECT_STATUS;\n" +
      "  if (asyncStatus != napi_ok) {\n" +
      "    c->status = asyncStatus;\n" +
      '    c->errorMsg = "Async audio frame send failed to complete.";\n' +
      "  }\n" +
      "  REJECT_STATUS;\n" +
      "  c->status = napi_create_object(env, &result);\n" +
      "  REJECT_STATUS;\n" +
      "  status = napi_resolve_deferred(env, c->_deferred, result);\n" +
      "  FLOATING_STATUS;\n" +
      "  tidyCarrier(env, c);\n" +
      "}\n" +
      "\n" +
      "napi_value audioSend(napi_env env, napi_callback_info info) {\n" +
      "  napi_valuetype type;\n" +
      "  sendDataCarrier* c = new sendDataCarrier;\n" +
      "  napi_value promise;\n" +
      "  c->status = napi_create_promise(env, &c->_deferred, &promise);\n" +
      "  REJECT_RETURN;\n" +
      "  size_t argc = 1;\n" +
      "  napi_value args[1];\n" +
      "  napi_value thisValue;\n" +
      "  c->status = napi_get_cb_info(env, info, &argc, args, &thisValue, nullptr);\n" +
      "  REJECT_RETURN;\n" +
      "  napi_value sendValue;\n" +
      '  c->status = napi_get_named_property(env, thisValue, "embedded", &sendValue);\n' +
      "  REJECT_RETURN;\n" +
      "  void* sendData;\n" +
      "  c->status = napi_get_value_external(env, sendValue, &sendData);\n" +
      "  c->send = (NDIlib_send_instance_t) sendData;\n" +
      "  REJECT_RETURN;\n" +
      "  if (argc < 1) REJECT_ERROR_RETURN(\n" +
      '    "audio frame not provided",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  napi_value config = args[0];\n" +
      "  c->status = napi_typeof(env, config, &type);\n" +
      "  REJECT_RETURN;\n" +
      "  if (type != napi_object) REJECT_ERROR_RETURN(\n" +
      '    "audio frame must be an object",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  napi_value param;\n" +
      '  c->status = napi_get_named_property(env, config, "sampleRate", &param);\n' +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_typeof(env, param, &type);\n" +
      "  REJECT_RETURN;\n" +
      "  if (type != napi_number) REJECT_ERROR_RETURN(\n" +
      '    "sampleRate value must be a number",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  c->status = napi_get_value_int32(env, param, &c->audioFrame.sample_rate);\n" +
      "  REJECT_RETURN;\n" +
      '  c->status = napi_get_named_property(env, config, "numChannels", &param);\n' +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_typeof(env, param, &type);\n" +
      "  REJECT_RETURN;\n" +
      "  if (type != napi_number) REJECT_ERROR_RETURN(\n" +
      '    "numChannels value must be a number",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  c->status = napi_get_value_int32(env, param, &c->audioFrame.no_channels);\n" +
      "  REJECT_RETURN;\n" +
      '  c->status = napi_get_named_property(env, config, "numSamples", &param);\n' +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_typeof(env, param, &type);\n" +
      "  REJECT_RETURN;\n" +
      "  if (type != napi_number) REJECT_ERROR_RETURN(\n" +
      '    "numSamples value must be a number",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  c->status = napi_get_value_int32(env, param, &c->audioFrame.no_samples);\n" +
      "  REJECT_RETURN;\n" +
      '  c->status = napi_get_named_property(env, config, "channelStrideInBytes", &param);\n' +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_typeof(env, param, &type);\n" +
      "  REJECT_RETURN;\n" +
      "  if (type != napi_number) REJECT_ERROR_RETURN(\n" +
      '    "channelStrideInBytes value must be a number",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  c->status = napi_get_value_int32(env, param, &c->audioFrame.channel_stride_in_bytes);\n" +
      "  REJECT_RETURN;\n" +
      "  napi_value audioBuffer;\n" +
      '  c->status = napi_get_named_property(env, config, "data", &audioBuffer);\n' +
      "  REJECT_RETURN;\n" +
      "  bool isBuffer;\n" +
      "  c->status = napi_is_buffer(env, audioBuffer, &isBuffer);\n" +
      "  REJECT_RETURN;\n" +
      "  if (!isBuffer) REJECT_ERROR_RETURN(\n" +
      '    "audio data must be provided as a Node Buffer",\n' +
      "    GRANDIOSE_INVALID_ARGS);\n" +
      "  void * audioData;\n" +
      "  size_t audioLength;\n" +
      "  c->status = napi_get_buffer_info(env, audioBuffer, &audioData, &audioLength);\n" +
      "  REJECT_RETURN;\n" +
      "  c->audioFrame.p_data = (float*) audioData;\n" +
      "  c->audioFrame.timecode = NDIlib_send_timecode_synthesize;\n" +
      "  c->audioFrame.p_metadata = nullptr;\n" +
      "  c->audioFrame.timestamp = 0;\n" +
      "  c->status = napi_create_reference(env, audioBuffer, 1, &c->sourceBufferRef);\n" +
      "  REJECT_RETURN;\n" +
      "  napi_value resource_name;\n" +
      '  c->status = napi_create_string_utf8(env, "AudioSend", NAPI_AUTO_LENGTH, &resource_name);\n' +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_create_async_work(env, NULL, resource_name, audioSendExecute,\n" +
      "    audioSendComplete, c, &c->_request);\n" +
      "  REJECT_RETURN;\n" +
      "  c->status = napi_queue_async_work(env, c->_request);\n" +
      "  REJECT_RETURN;\n" +
      "  return promise;\n" +
      "}\n" +
      `${AUDIO_PATCH_SENTINEL} END\n`;
    next = next + audioImpl;
    process.stdout.write(
      "[patch-grandiose] Appended audioSend implementation to src/grandiose_send.cc\n",
    );
  }

  if (next !== original) {
    fs.writeFileSync(sendImpl, next, "utf8");
    touched = true;
  }
}

const bindingOriginal = fs.readFileSync(bindingGyp, "utf8");
if (!bindingOriginal.includes("VCCLCompilerTool")) {
  const winBlockMatch = bindingOriginal.match(
    /(\["OS=='win'", \{[\s\S]*?)(\}\],\s*\["OS=='linux'")/
  );
  let next = bindingOriginal;
  if (winBlockMatch) {
    const insertion = `          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [ "/permissive", "/Zc:strictStrings-" ]
            }
          },
`;
    const replaced = winBlockMatch[1] + insertion + winBlockMatch[2];
    next = bindingOriginal.replace(winBlockMatch[0], replaced);
  } else {
    const targetsMatch = next.match(/("targets":\s*\[\s*\{)/);
    if (targetsMatch) {
      const insertion = `\n      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [ "/permissive", "/Zc:strictStrings-" ]
        }
      },\n`;
      next = next.replace(targetsMatch[0], targetsMatch[0] + insertion);
    }
  }
  if (next !== bindingOriginal) {
    fs.writeFileSync(bindingGyp, next, "utf8");
    process.stdout.write("[patch-grandiose] Patched binding.gyp (added MSVC compiler flags)\n");
    touched = true;
  }
}

const buildDir = path.join(grandioseDir, "build");
const releaseNode = path.join(buildDir, "Release", "grandiose.node");
const alreadyBuilt = fs.existsSync(releaseNode);

if (touched || !alreadyBuilt) {
  process.stdout.write("[patch-grandiose] Rebuilding native binding...\n");
  const result = spawnSync("npm", ["rebuild", "grandiose"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    process.stderr.write(
      "[patch-grandiose] npm rebuild grandiose failed. NDI features will be unavailable.\n"
    );
    process.exit(1);
  }
}

if (fs.existsSync(releaseNode)) {
  process.stdout.write(`[patch-grandiose] OK: ${releaseNode}\n`);
} else {
  process.stderr.write(`[patch-grandiose] WARN: ${releaseNode} missing after rebuild.\n`);
}
