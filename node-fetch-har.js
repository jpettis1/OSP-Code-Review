// module for providing utilities for url resolution and parsing
const { URL } = require("url");
// module to interact with http server and allow transfer of data over the HTTP
const http = require("http");
// provides a way of making Node. js transfer data over HTTP TLS/SSL protocol, which is the secure HTTP protocol
const https = require("https");
// provides a way to parse url query string
const querystring = require("querystring");
// unique string ID generator for JS
const generateId = require("nanoid");
// allows for getting and setting of HTTP(s) cookies
const cookie = require("cookie");
// returns an array of cookies - values depend on set cookie header
const setCookie = require("set-cookie-parser");
// name and version from package json - not sure what they is used for yet
const fetch = require("node-fetch");

const {
  name: packageName,
  version: packageVersion,
} = require("./package.json");

// Not sure what this is for yet
const headerName = "x-har-request-id";
const harEntryMap = new Map();

function getDuration(a, b) {
  const seconds = b[0] - a[0];
  const nanoseconds = b[1] - a[1];
  return seconds * 1000 + nanoseconds / 1e6;
}

function handleRequest(request, options) {
  // checking for options obj passed into the invocation of addRequest as (...args)
  // includes information, such as headers, host, method, protocol, port, etc.
  // if this data is not avaliable, return
  if (!options || typeof options !== "object") {
    return;
  }
  // headers now set to {} containing various props including x-har-request-id:(1)["ZQqNkmxNPNYQwv1P5SCRs"];
  // or empty obj
  const headers = options.headers || {};
  const requestId = headers[headerName] ? headers[headerName][0] : null;

  if (!requestId) {
    return;
  }

  // Redirects! Fetch follows them (in `follow`) mode and uses the same request
  // headers. So we'll see multiple requests with the same ID. We should remove
  // any previous entry from `harEntryMap` and attach it as a "parent" to this
  // one.
  const parentEntry = harEntryMap.get(requestId);
  if (parentEntry) {
    harEntryMap.delete(requestId);
  }

  const now = Date.now();
  // The process.hrtime() method to measure code execution time which
  //returns array which include current high-resolution real time in a [seconds, nanoseconds].
  const startTime = process.hrtime();
  const url = new URL(options.url || options.href); // Depends on Node version?

  // creating new entry obj
  const entry = {
    // parent entry - will be null for the first request,
    // subsequent requests will recieved the val in harEntryMap
    _parent: parentEntry,
    _timestamps: {
      start: startTime,
    },
    _resourceType: "fetch",
    // Date and time stamp of the request start
    startedDateTime: new Date(now).toISOString(),
    // info about cache usage
    cache: {
      beforeRequest: null,
      afterRequest: null,
    },
    // Detailed timing info about request/response round trip.
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: 0,
      receive: 0,
      ssl: -1,
    },
    request: {
      method: request.method,
      url: url.href,
      cookies: buildRequestCookies(headers),
      headers: buildHeaders(headers),
      queryString: [...url.searchParams].map(([name, value]) => ({
        name,
        value,
      })),
      headersSize: -1,
      bodySize: -1,
    },
  };

  // Some versions of `node-fetch` will put `body` in the `options` received by
  // this function and others exclude it. Instead we have to capture writes to
  // the `ClientRequest` stream. There might be some official way to do this
  // with streams, but the events and piping I tried didn't work. FIXME?
  const _write = request.write;
  const _end = request.end;
  let requestBody;

  const concatBody = (chunk) => {
    // Assume the writer will be consistent such that we wouldn't get Buffers in
    // some writes and strings in others.
    if (typeof chunk === "string") {
      if (requestBody == null) {
        requestBody = chunk;
      } else {
        requestBody += chunk;
      }
    } else if (Buffer.isBuffer(chunk)) {
      if (requestBody == null) {
        requestBody = chunk;
      } else {
        requestBody = Buffer.concat([requestBody, chunk]);
      }
    }
  };

  request.write = function (...args) {
    concatBody(...args);
    return _write.call(this, ...args);
  };

  // on emit end of request populate postData on request obj within entry
  request.end = function (...args) {
    concatBody(...args);

    if (requestBody != null) {
      // Works for both buffers and strings.
      entry.request.bodySize = Buffer.byteLength(requestBody);
      // media type / content type
      let mimeType;
      // getting the media type from headers
      for (const name in headers) {
        if (name.toLowerCase() === "content-type") {
          mimeType = headers[name][0];
          break;
        }
      }

      if (mimeType) {
        const bodyString = requestBody.toString(); // FIXME: Assumes encoding?
        if (mimeType === "application/x-www-form-urlencoded") {
          entry.request.postData = {
            // mimeType [string] - Mime type of posted data.
            mimeType,
            // params [array] - List of posted parameters (in case of URL encoded parameters).
            params: buildParams(bodyString),
          };
        } else {
          // text [string] - Plain text posted data
          entry.request.postData = { mimeType, text: bodyString };
        }
      }
    }

    return _end.call(this, ...args);
  };

  let removeSocketListeners;

  request.on("socket", (socket) => {
    entry._timestamps.socket = process.hrtime();

    const onLookup = () => {
      entry._timestamps.lookup = process.hrtime();
    };

    const onConnect = () => {
      entry._timestamps.connect = process.hrtime();
    };

    const onSecureConnect = () => {
      entry._timestamps.secureConnect = process.hrtime();
    };

    socket.once("lookup", onLookup);
    socket.once("connect", onConnect);
    socket.once("secureConnect", onSecureConnect);

    removeSocketListeners = () => {
      socket.removeListener("lookup", onLookup);
      socket.removeListener("connect", onConnect);
      socket.removeListener("secureConnect", onSecureConnect);
    };
  });

  request.on("finish", () => {
    entry._timestamps.sent = process.hrtime();
    removeSocketListeners();
  });

  request.on("response", (response) => {
    entry._timestamps.firstByte = process.hrtime();
    harEntryMap.set(requestId, entry);

    // Now we know whether `lookup` or `connect` happened. It's possible they
    // were skipped if the hostname was already resolved (or we were given an
    // IP directly), or if a connection was already open (e.g. due to
    // `keep-alive`).
    if (!entry._timestamps.lookup) {
      entry._timestamps.lookup = entry._timestamps.socket;
    }
    if (!entry._timestamps.connect) {
      entry._timestamps.connect = entry._timestamps.lookup;
    }

    // Populate request info that isn't available until now.
    const httpVersion = `HTTP/${response.httpVersion}`;
    entry.request.httpVersion = httpVersion;

    entry.response = {
      status: response.statusCode,
      statusText: response.statusMessage,
      httpVersion,
      cookies: buildResponseCookies(response.headers),
      headers: buildHeaders(response.rawHeaders),
      content: {
        size: -1,
        mimeType: response.headers["content-type"],
      },
      redirectURL: response.headers.location || "",
      headersSize: -1,
      bodySize: -1,
    };

    // Detect supported compression encodings.
    const compressed = /^(gzip|compress|deflate|br)$/.test(
      response.headers["content-encoding"]
    );

    if (compressed) {
      entry._compressed = true;
      response.on("data", (chunk) => {
        if (entry.response.bodySize === -1) {
          entry.response.bodySize = 0;
        }
        entry.response.bodySize += Buffer.byteLength(chunk);
      });
    }
  });
}

/**
 * Support the three possible header formats we'd get from a request or
 * response:
 *
 * - A flat array with both names and values: [name, value, name, value, ...]
 * - An object with array values: { name: [value, value] }
 * - An object with string values: { name: value }
 */
function buildHeaders(headers) {
  const list = [];
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      list.push({
        name: headers[i],
        value: headers[i + 1],
      });
    }
  } else {
    Object.keys(headers).forEach((name) => {
      const values = Array.isArray(headers[name])
        ? headers[name]
        : [headers[name]];
      values.forEach((value) => {
        list.push({ name, value });
      });
    });
  }
  return list;
}

function buildRequestCookies(headers) {
  const cookies = [];
  for (const header in headers) {
    if (header.toLowerCase() === "cookie") {
      headers[header].forEach((headerValue) => {
        const parsed = cookie.parse(headerValue);
        for (const name in parsed) {
          const value = parsed[name];
          cookies.push({ name, value });
        }
      });
    }
  }
  return cookies;
}

function buildParams(paramString) {
  const params = [];
  const parsed = querystring.parse(paramString);
  for (const name in parsed) {
    const value = parsed[name];
    if (Array.isArray(value)) {
      value.forEach((item) => {
        params.push({ name, value: item });
      });
    } else {
      params.push({ name, value });
    }
  }
  return params;
}

function buildResponseCookies(headers) {
  const cookies = [];
  const setCookies = headers["set-cookie"];
  if (setCookies) {
    setCookies.forEach((headerValue) => {
      let parsed;
      try {
        parsed = setCookie.parse(headerValue);
      } catch (err) {
        return;
      }
      parsed.forEach((cookie) => {
        const { name, value, path, domain, expires, httpOnly, secure } = cookie;
        const harCookie = {
          name,
          value,
          httpOnly: httpOnly || false,
          secure: secure || false,
        };
        if (path) {
          harCookie.path = path;
        }
        if (domain) {
          harCookie.domain = domain;
        }
        if (expires) {
          harCookie.expires = expires.toISOString();
        }
        cookies.push(harCookie);
      });
    });
  }
  return cookies;
}

/**
 * Instrument an existing Agent instance. This overrides the instance's
 * `addRequest` method. It should be fine to continue using for requests made
 * without `withHar` - if the request doesn't have our `x-har-request-id`
 * header, it won't do anything extra.
 */
function instrumentAgentInstance(agent) {
  const { addRequest: originalAddRequest } = agent;
  if (!originalAddRequest.isHarEnabled) {
    agent.addRequest = function addRequest(request, ...args) {
      handleRequest(request, ...args);
      // I believe that this is calling the addRequest on the agent's prototype
      // with this pointing to agent
      return originalAddRequest.call(this, request, ...args);
    };
    agent.addRequest.isHarEnabled = true;
  }
}

// creating custom agent class by adding custom addRequest
// method to the prototype, which implements request handler
// and then passes off the request to the original prototype method Agent.addRequest
function createAgentClass(BaseAgent) {
  class HarAgent extends BaseAgent {
    constructor(...args) {
      super(...args);
      this.addRequest.isHarEnabled = true;
    }

    // This method is undocumented in the Node.js Agent docs. But every custom
    // agent implementation out there uses it, so...
    // this serves as a wrapper so that request handlers can be added first within
    // handleRequest before establishing a connection
    addRequest(request, ...args) {
      // This function adds event listners to the request object to capture data
      // and add to entry, without this the reponse is entirely discarded
      // To read further see Node docs - https://nodejs.org/api/http.html#class-httpclientrequest
      handleRequest(request, ...args);
      // This method is where the connection is initiated and sockets are either
      // reused, created, or added to the queue - https://github.com/nodejs/node/blob/main/lib/_http_agent.js
      return super.addRequest(request, ...args);
    }
  }

  return HarAgent;
}

const HarHttpAgent = createAgentClass(http.Agent);
const HarHttpsAgent = createAgentClass(https.Agent);

// Shared agent instances.
let globalHttpAgent;
let globalHttpsAgent;

function getInputUrl(input) {
  // Support URL or Request object.
  const url = typeof input === "string" ? input : input.url;
  return new URL(url);
}

//#3)
// oldHeaders - headers passed into fetch invocation
// newHeaders - headerName: requestId
function addHeaders(oldHeaders, newHeaders) {
  // simply return new header with id and generated id as value
  if (!oldHeaders) {
    return newHeaders;
  } else if (
    // checking to see if obj is map or obj
    typeof oldHeaders.set === "function" &&
    typeof oldHeaders.constructor === "function"
  ) {
    const Headers = oldHeaders.constructor;
    const headers = new Headers(oldHeaders);
    for (const name in newHeaders) {
      headers.set(name, newHeaders[name]);
    }
    return headers;
  } else {
    return Object.assign({}, oldHeaders, newHeaders);
  }
}

//#3)
function getAgent(input, options) {
  // input is URL endpoint
  // if agent is passed in as an option to modifiedFetch, as opposed to using default
  // (e.g. modifiedFetch("url", { agent: new http.agent() }))
  // custom global agent
  if (options.agent) {
    // if we pass http.agent as a value to key agent within the options obj for fetch
    // (e.g. modifiedFetch("url", { agent: http.Agent }))
    if (typeof options.agent === "function") {
      // ??? args is the "options" in "agent: getAgent(input, options)"???
      return function (...args) {
        // call changes the context of 'this' when invoking agent
        const agent = options.agent.call(this, ...args);
        if (agent) {
          // Instrumenting an existing agent instance (e.g. if agent was passed into options upon
          // invocation of fetch) - instrumentation usually means adding some performance measurement
          // tools to the code - in this case we are adding an identifier via isHarEnabled prop to identify
          // that HAR log functionality is enabled for this particular fetch / agent
          instrumentAgentInstance(agent);
          return agent;
        }
        return getGlobalAgent(input);
      };
    }
    instrumentAgentInstance(options.agent);
    return options.agent;
  }
  // getting custom global Agent instance
  return getGlobalAgent(input);
}

// This function checks to see if a global agent has already been created,
// else it creates one
// By default, http.request() uses a global agent with default params set
// If you want to customize params you have to create an instance and pass as options
function getGlobalAgent(input) {
  const url = getInputUrl(input);
  if (url.protocol === "http:") {
    if (!globalHttpAgent) {
      globalHttpAgent = new HarHttpAgent();
    }
    return globalHttpAgent;
  }
  if (!globalHttpsAgent) {
    globalHttpsAgent = new HarHttpsAgent();
  }
  return globalHttpsAgent;
}

// method that is called first, passing in node-fetch as the base fetch
// defaults intialized to empty obj or passing in default key/val pairs (e.g. onHarEntry, har) - these are
// passed to the options object within the return function and get captured in the closure
//#1)
function withHar(baseFetch, defaults = {}) {
  //#2)
  return function fetch(input, options = {}) {
    // setting default values on the options object if values are not defined
    const {
      har = defaults.har,
      // Reference to the parent page.
      // Leave out this field if the application does not support grouping by pages.
      // Not quite sure why this is important..
      harPageRef = defaults.harPageRef,
      onHarEntry = defaults.onHarEntry,
    } = options;
    // checking to see if user has implicity requested not to track har entries
    // for specific request, return fetch without tracking
    if (har === false) {
      return baseFetch(input, options);
    }

    // Ideally we could just attach the generated entry data to the request
    // directly, like via a header. An ideal place would be in a header, but the
    // headers are already processed by the time the response is finished, so we
    // can't add it there.
    //
    // We could also give each request its own Agent instance that knows how to
    // populate an entry for each given request, but it seems expensive to
    // create new one for every single request.
    //
    // So instead, we generate an ID for each request and attach it to a request
    // header. The agent then adds the entry data to `harEntryMap` using the ID
    // as a key.
    // Id generated for each request - key for the entry within harEntryMap
    const requestId = generateId();
    // const requestId = "fake_requestId";
    // Assigning headers and current options object values to options
    options = Object.assign({}, options, {
      // { "x-har-request-id" : requestId } <-- with square brackets
      // { "headerName" : requestId } <-- without square brackets
      headers: addHeaders(options.headers, { [headerName]: requestId }),
      // node-fetch 2.x supports a function here, but 1.x does not. So parse
      // the URL and implement protocol-switching ourselves.
      // get custom agent class to pass into baseFetch to handle request
      agent: getAgent(input, options),
    });

    return baseFetch(input, options).then(
      async (response) => {
        const entry = harEntryMap.get(requestId);
        harEntryMap.delete(requestId);

        if (!entry) {
          return response;
        }

        // We need to consume the decoded response in order to populate the
        // `response.content` field.
        const text = await response.text();

        const { _timestamps: time } = entry;
        time.received = process.hrtime();

        const parents = [];
        let child = entry;
        do {
          const parent = child._parent;
          // Remove linked parent references as they're flattened.
          delete child._parent;
          if (parent) {
            parents.unshift(parent);
          }
          child = parent;
        } while (child);

        // In some versions of `node-fetch`, the returned `response` is actually
        // an instance of `Body`, not `Response`, and the `Body` class does not
        // set a `headers` property when constructed. So instead of using
        // `response.constructor`, try to get `Response` from other places, like
        // on the given Fetch instance or the global scope (like `isomorphic-fetch`
        // sets). If all else fails, you can override the class used via the
        // `Response` option to `withHar`.
        const Response =
          defaults.Response ||
          baseFetch.Response ||
          global.Response ||
          response.constructor;

        // `clone()` is broken in `node-fetch` and results in a stalled Promise
        // for responses above a certain size threshold. So construct a similar
        // clone ourselves...
        const responseCopy = new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          // These are not spec-compliant `Response` options, but `node-fetch`
          // has them.
          ok: response.ok,
          size: response.size,
          url: response.url,
        });

        // Allow grouping by pages.
        entry.pageref = harPageRef || "page_1";
        parents.forEach((parent) => {
          parent.pageref = entry.pageref;
        });
        // Response content info.
        const bodySize = Buffer.byteLength(text);
        entry.response.content.text = text;
        entry.response.content.size = bodySize;
        if (entry._compressed) {
          if (entry.response.bodySize !== -1) {
            entry.response.content.compression =
              entry.response.content.size - entry.response.bodySize;
          }
        } else {
          entry.response.bodySize = bodySize;
        }
        // Finalize timing info.
        // Chrome's HAR viewer (the Network panel) is broken and doesn't honor
        // the HAR spec. If `blocked` is not a positive number, it shows the
        // `wait` time as stalled instead of the time waiting for the response.
        entry.timings.blocked = Math.max(
          getDuration(time.start, time.socket),
          0.01 // Minimum value, see above.
        );
        entry.timings.dns = getDuration(time.socket, time.lookup);
        entry.timings.connect = getDuration(
          time.lookup,
          // For backwards compatibility with HAR 1.1, the `connect` timing
          // includes `ssl` instead of being mutually exclusive.
          time.secureConnect || time.connect
        );
        if (time.secureConnect) {
          entry.timings.ssl = getDuration(time.connect, time.secureConnect);
        }
        entry.timings.send = getDuration(
          time.secureConnect || time.connect,
          time.sent
        );
        entry.timings.wait = Math.max(
          // Seems like it might be possible to receive a response before the
          // request fires its `finish` event. This is just a hunch and it would
          // be worthwhile to disprove.
          getDuration(time.sent, time.firstByte),
          0
        );
        entry.timings.receive = getDuration(time.firstByte, time.received);
        entry.time = getDuration(time.start, time.received);

        responseCopy.harEntry = entry;

        if (har && typeof har === "object") {
          har.log.entries.push(...parents, entry);
        }

        if (onHarEntry) {
          parents.forEach((parent) => {
            onHarEntry(parent);
          });
          onHarEntry(entry);
        }

        return responseCopy;
      },
      (err) => {
        harEntryMap.delete(requestId);
        throw err;
      }
    );
  };
}

withHar.harEntryMap = harEntryMap;

function createHarLog(entries = [], pageInfo = {}) {
  return {
    log: {
      version: "1.2",
      creator: {
        name: packageName,
        version: packageVersion,
      },
      pages: [
        Object.assign(
          {
            startedDateTime: new Date().toISOString(),
            id: "page_1",
            title: "Page",
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1,
            },
          },
          pageInfo
        ),
      ],
      entries,
    },
  };
}

const newFetch = withHar(fetch);
const data = {
  Annie: "I'm ok",
};
const data2 = {
  Annie2: "I'm ok2",
};
const fetchData = async () => {
  await newFetch("https://curriculum-api.codesmith.io/messages");
  // await newFetch("https://example.com/profile2", {
  //   method: "POST", // or 'PUT'
  //   headers: {
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify(data2),
  //   agent: http.Agent,
  // });
};
fetchData();

// exports.withHar = withHar;
// exports.createHarLog = createHarLog;
