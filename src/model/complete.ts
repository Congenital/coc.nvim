import {score} from 'fuzzaldrin'
import { Neovim } from 'neovim'
import {CompleteOption,
  VimCompleteItem,
  CompleteResult} from '../types'
import buffers from '../buffers'
import Source from './source'
import {getConfig} from '../config'
import {wordSortItems} from '../util/sorter'
import {equalChar} from '../util/index'
import {uniqueItems} from '../util/unique'
import {filterFuzzy, filterWord} from '../util/filter'
const logger = require('../util/logger')('model-complete')

export type Callback = () => void

export default class Complete {
  // identify this complete
  public results: CompleteResult[] | null
  public option: CompleteOption
  constructor(opts: CompleteOption) {
    this.option = opts
  }

  public resuable(complete: Complete):boolean {
    let {col, colnr, input, line, linenr} = complete.option
    if (!this.results
      || linenr !== this.option.linenr
      || colnr < this.option.colnr
      || !input.startsWith(this.option.input)
      || line.slice(0, col) !== this.option.line.slice(0, col)
      || col !== this.option.col) return false
    let buf = buffers.getBuffer(this.option.bufnr.toString())
    if (!buf) return false
    let more = line.slice(col)
    return buf.isWord(more)
  }

  private completeSource(source: Source, opt: CompleteOption): Promise<CompleteResult | null> {
    let {engross} = source
    return new Promise(resolve => {
      let called = false
      let start = Date.now()
      source.doComplete(opt).then(result => {
        called = true
        if (engross
          && result != null
          && result.items
          && result.items.length) {
          result.engross = true
        }
        resolve(result)
        logger.info(`Complete '${source.name}' takes ${Date.now() - start}ms`)
      }, error => {
        called = true
        logger.error(`Complete error of source '${source.name}'`)
        logger.error(error.stack)
        resolve(null)
      })
      setTimeout(() => {
        if (!called) {
          logger.warn(`Complete source '${source.name}' too slow!`)
          resolve(null)
        }
      }, getConfig('timeout'))
    })
  }

  public filterResults(results: CompleteResult[], isResume: boolean):VimCompleteItem[] {
    let arr: VimCompleteItem[] = []
    let {input, id} = this.option
    let fuzzy = getConfig('fuzzyMatch')
    let filter = fuzzy ? filterFuzzy : filterWord
    let icase = !/[A-Z]/.test(input)
    for (let i = 0, l = results.length; i < l; i++) {
      let res = results[i]
      let {items} = res
      for (let item of items) {
        let {word, kind, info, user_data} = item
        let data = {}
        if (input.length && !filter(input, word, icase)) continue
        if (user_data) {
          try {
            data = JSON.parse(user_data)
          } catch (e) {} // tslint:disable-line
        }
        data = Object.assign(data, { cid: id })
        item.user_data = JSON.stringify(data)
        if (fuzzy) item.score = score(word, input) + (kind || info ? 0.01 : 0)
        arr.push(item)
      }
    }
    if (fuzzy) {
      arr.sort((a, b) => {
        return b.score - a.score
      })
    } else {
      arr = wordSortItems(arr, input)
    }
    return uniqueItems(arr)
  }

  public async doComplete(sources: Source[]): Promise<[number, VimCompleteItem[]]> {
    let opts = this.option
    let {col} = opts
    let valids: Source[] = []
    for (let s of sources) {
      let shouldRun = await s.shouldComplete(opts)
      if (!shouldRun) continue
      valids.push(s)
    }
    if (valids.length == 0) {
      logger.debug('No source to complete')
      return [col, []]
    }
    valids.sort((a, b) => b.priority - a.priority)
    logger.debug(`Working sources: ${valids.map(s => s.name).join(',')}`)
    let results = await Promise.all(valids.map(s => this.completeSource(s, opts)))
    results = results.filter(r => {
      return r != null && r.items && r.items.length
    })
    let engrossResult = results.find(r => r.engross === true)
    if (engrossResult) {
      if (engrossResult.startcol != null) {
        col = engrossResult.startcol
      }
      results = [engrossResult]
      logger.debug(`Engross source activted`)
    }
    // use it even it's bad
    this.results = results
    let filteredResults = this.filterResults(results, false)
    return [col, filteredResults]
  }
}
