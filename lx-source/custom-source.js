/**
 * @name LX-Source 聚合调度加速版
 * @version 1.0.0
 * @author LX-Source Community
 * @description 多源聚合、国内直连加速、假音频拦截、链式容灾的自定义音源
 * @homepage https://github.com/YOUR_USERNAME/lx-source
 */

;(function () {
  'use strict'

  var CONFIG_VERSION = '1.0.0'
  var RULES_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/lx-source/main/rules.json'
  var REQUEST_TIMEOUT = 2500
  var PRECHECK_TIMEOUT = 3000
  var MAX_FAKE_SIZE = 1572864
  var MIN_VALID_SIZE = 1048576

  var GITHUB_MIRRORS = [
    'https://ghfast.top/',
    'https://ghproxy.net/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.cn/',
    'https://gh-proxy.com/',
    'https://github.moeyy.xyz/'
  ]

  var SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']
  var QUALITYS = ['128k', '320k', 'flac', 'flac24bit']

  var FAKE_AUDIO_PATTERNS = [
    /请到.*收听/gi,
    /版权.*限制/gi,
    /VIP.*专享/gi,
    /请.*APP/gi,
    /支持正版/gi,
    /开通会员/gi
  ]

  var BLACKLIST_DOMAINS = [
    'ad.example.com',
    'promo.example.com',
    'redirect.example.com'
  ]

  var ERROR_CODES = [403, 404, 410, 451]

  var _rules = null
  var _rulesLoaded = false
  var _sourceStats = {}

  function toDomesticUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl
    if (/^https?:\/\/github\.com\//.test(rawUrl)) {
      var path = rawUrl.replace(/^https?:\/\/github\.com\//, '')
      return GITHUB_MIRRORS[0] + 'https://github.com/' + path
    }
    if (/^https?:\/\/raw\.githubusercontent\.com\//.test(rawUrl)) {
      return GITHUB_MIRRORS[0] + rawUrl
    }
    return rawUrl
  }

  function requestWithMirror(url, options, callback) {
    var mirrors = GITHUB_MIRRORS.slice()
    var idx = 0

    function tryNext() {
      if (idx >= mirrors.length) {
        return lx.request(url, options, callback)
      }
      var mirrorUrl = mirrors[idx] + url
      idx++
      var timer = setTimeout(function () {
        tryNext()
      }, REQUEST_TIMEOUT)

      lx.request(mirrorUrl, options, function (err, resp, body) {
        clearTimeout(timer)
        if (err || !resp || resp.statusCode >= 400) {
          tryNext()
        } else {
          callback(err, resp, body)
        }
      })
    }

    tryNext()
  }

  function fetchRules() {
    if (_rulesLoaded) return Promise.resolve(_rules)

    return new Promise(function (resolve) {
      var url = toDomesticUrl(RULES_URL)
      var timer = setTimeout(function () {
        resolve(_rules)
      }, 5000)

      requestWithMirror(url, { method: 'get', timeout: 5000 }, function (err, resp, body) {
        clearTimeout(timer)
        if (!err && body && typeof body === 'object') {
          _rules = body
          _rulesLoaded = true
          applyRules(body)
          resolve(body)
        } else {
          resolve(_rules)
        }
      })
    })
  }

  function applyRules(rules) {
    if (!rules) return
    if (rules.mirrors && rules.mirrors.github) {
      GITHUB_MIRRORS.length = 0
      rules.mirrors.github.forEach(function (m) {
        GITHUB_MIRRORS.push(m)
      })
    }
    if (rules.mirrors && rules.mirrors.timeout) {
      REQUEST_TIMEOUT = rules.mirrors.timeout
    }
    if (rules.fakeAudioFilter) {
      var f = rules.fakeAudioFilter
      if (f.maxFileSize) MAX_FAKE_SIZE = f.maxFileSize
      if (f.minValidSize) MIN_VALID_SIZE = f.minValidSize
      if (f.timeout) PRECHECK_TIMEOUT = f.timeout
      if (f.blacklistDomains) BLACKLIST_DOMAINS = f.blacklistDomains
      if (f.errorCodes) ERROR_CODES = f.errorCodes
      if (f.fakeAudioPatterns) {
        FAKE_AUDIO_PATTERNS = f.fakeAudioPatterns.map(function (p) {
          return new RegExp(p, 'gi')
        })
      }
    }
  }

  function getUpstreams(source) {
    if (_rules && _rules.upstreams && _rules.upstreams[source]) {
      return _rules.upstreams[source].filter(function (u) {
        return u.enabled !== false
      }).sort(function (a, b) {
        return (a.priority || 1) - (b.priority || 1)
      })
    }
    if (_rules && _rules.localFallback && _rules.localFallback[source]) {
      return _rules.localFallback[source]
    }
    return []
  }

  function isBlacklistedDomain(url) {
    if (!url) return false
    for (var i = 0; i < BLACKLIST_DOMAINS.length; i++) {
      if (url.indexOf(BLACKLIST_DOMAINS[i]) !== -1) return true
    }
    return false
  }

  function isFakeAudio(headers, body, url) {
    if (isBlacklistedDomain(url)) return true

    if (headers) {
      var contentLength = parseInt(headers['content-length'], 10)
      if (!isNaN(contentLength) && contentLength > 0 && contentLength < MIN_VALID_SIZE) {
        return true
      }
      var contentType = headers['content-type'] || ''
      if (contentType.indexOf('text/html') !== -1) return true
    }

    if (body && typeof body === 'string') {
      for (var i = 0; i < FAKE_AUDIO_PATTERNS.length; i++) {
        FAKE_AUDIO_PATTERNS[i].lastIndex = 0
        if (FAKE_AUDIO_PATTERNS[i].test(body)) return true
      }
    }

    return false
  }

  function precheckAudio(url) {
    return new Promise(function (resolve) {
      if (!url || isBlacklistedDomain(url)) {
        return resolve(false)
      }

      var timer = setTimeout(function () {
        resolve(true)
      }, PRECHECK_TIMEOUT)

      lx.request(url, {
        method: 'get',
        timeout: PRECHECK_TIMEOUT,
        headers: { 'Range': 'bytes=0-1024' }
      }, function (err, resp) {
        clearTimeout(timer)
        if (err) {
          resolve(false)
          return
        }

        if (resp && ERROR_CODES.indexOf(resp.statusCode) !== -1) {
          resolve(false)
          return
        }

        if (resp && resp.headers) {
          var cl = parseInt(resp.headers['content-length'], 10)
          if (!isNaN(cl) && cl > 0 && cl < MIN_VALID_SIZE) {
            resolve(false)
            return
          }
        }

        var bodyStr = ''
        if (resp && resp.body) {
          bodyStr = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
        }

        if (isFakeAudio(resp ? resp.headers : null, bodyStr, url)) {
          resolve(false)
          return
        }

        resolve(true)
      })
    })
  }

  function fetchMusicUrl(upstream, songInfo) {
    return new Promise(function (resolve, reject) {
      var apiUrl = upstream.url
      var params = []
      if (songInfo.songmid) params.push('songmid=' + encodeURIComponent(songInfo.songmid))
      if (songInfo.songId) params.push('songId=' + encodeURIComponent(songInfo.songId))
      if (songInfo.quality) params.push('quality=' + encodeURIComponent(songInfo.quality))
      if (songInfo.source) params.push('source=' + encodeURIComponent(songInfo.source))
      if (songInfo.name) params.push('name=' + encodeURIComponent(songInfo.name))
      if (songInfo.singer) params.push('singer=' + encodeURIComponent(songInfo.singer))
      if (songInfo.album) params.push('album=' + encodeURIComponent(songInfo.album))

      if (params.length > 0) {
        apiUrl += (apiUrl.indexOf('?') === -1 ? '?' : '&') + params.join('&')
      }

      var timer = setTimeout(function () {
        reject(new Error('upstream timeout'))
      }, REQUEST_TIMEOUT)

      lx.request(apiUrl, { method: 'get', timeout: REQUEST_TIMEOUT }, function (err, resp, body) {
        clearTimeout(timer)
        if (err) return reject(err)

        if (resp && ERROR_CODES.indexOf(resp.statusCode) !== -1) {
          return reject(new Error('http ' + resp.statusCode))
        }

        var url = null
        if (typeof body === 'string' && /^https?:/.test(body)) {
          url = body.trim()
        } else if (body && typeof body === 'object') {
          url = body.url || body.data && body.data.url || body.data && typeof body.data === 'string' ? body.data : null
        }

        if (!url || !/^https?:/.test(url)) {
          return reject(new Error('invalid url'))
        }

        resolve(url)
      })
    })
  }

  function updateStats(source, success) {
    if (!_sourceStats[source]) {
      _sourceStats[source] = { success: 0, fail: 0, avgTime: 2000 }
    }
    if (success) {
      _sourceStats[source].success++
    } else {
      _sourceStats[source].fail++
    }
  }

  function handleMusicUrl(songInfo) {
    var source = songInfo.source || ''
    var quality = songInfo.quality || '128k'

    var upstreams = getUpstreams(source)
    if (upstreams.length === 0) {
      return Promise.reject(new Error('no available upstream for ' + source))
    }

    var chain = Promise.reject()

    upstreams.forEach(function (upstream) {
      chain = chain.catch(function () {
        return fetchMusicUrl(upstream, songInfo).then(function (url) {
          return precheckAudio(url).then(function (valid) {
            if (!valid) {
              updateStats(source, false)
              throw new Error('fake audio detected')
            }
            updateStats(source, true)
            return url
          })
        })
      })
    })

    return chain
  }

  function initSource() {
    var sources = {}
    SOURCES.forEach(function (s) {
      sources[s] = {
        type: 'music',
        actions: ['musicUrl'],
        qualitys: QUALITYS.slice()
      }
    })

    lx.send('inited', {
      sources: sources,
      message: 'LX-Source v' + CONFIG_VERSION + ' loaded'
    })
  }

  fetchRules().then(function () {
    initSource()
  })

  lx.on('request', function (data) {
    if (data.action === 'musicUrl') {
      return handleMusicUrl(data.info)
    }
    return Promise.reject(new Error('unsupported action'))
  })

})()
