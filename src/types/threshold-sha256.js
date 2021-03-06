'use strict'

/**
 * @module types
 */

const Condition = require('../lib/condition')
const Fulfillment = require('../lib/fulfillment')
const BaseSha256 = require('./base-sha256')
const Predictor = require('oer-utils/predictor')
const Writer = require('oer-utils/writer')
const MissingDataError = require('../errors/missing-data-error')
const ParseError = require('../errors/parse-error')
const isInteger = require('core-js/library/fn/number/is-integer')

const EMPTY_BUFFER = new Buffer(0)

const CONDITION = 'condition'
const FULFILLMENT = 'fulfillment'

/**
 * THRESHOLD-SHA-256: Threshold gate condition using SHA-256.
 *
 * Threshold conditions can be used to create m-of-n multi-signature groups.
 *
 * Threshold conditions can represent the AND operator by setting the threshold
 * to equal the number of subconditions (n-of-n) or the OR operator by setting
 * the thresold to one (1-of-n).
 *
 * Threshold conditions allows each subcondition to carry an integer weight.
 *
 * Since threshold conditions operate on conditions, they can be nested as well
 * which allows the creation of deep threshold trees of public keys.
 *
 * By using Merkle trees, threshold fulfillments do not need to to provide the
 * structure of unfulfilled subtrees. That means only the public keys that are
 * actually used in a fulfillment, will actually appear in the fulfillment,
 * saving space.
 *
 * One way to formally interpret threshold conditions is as a boolean weighted
 * threshold gate. A tree of threshold conditions forms a boolean weighted
 * threhsold circuit.
 *
 * THRESHOLD-SHA-256 is assigned the type ID 2. It relies on the SHA-256 and
 * THRESHOLD feature suites which corresponds to a feature bitmask of 0x09.
 */
class ThresholdSha256 extends BaseSha256 {
  constructor () {
    super()

    this.threshold = null
    this.subconditions = []
  }

  /**
   * Add a subcondition (unfulfilled).
   *
   * This can be used to generate a new threshold condition from a set of
   * subconditions or to provide a non-fulfilled subcondition when creating a
   * threshold fulfillment.
   *
   * @param {Condition|String} subcondition Condition object or URI string
   *   representing a new subcondition to be added.
   * @param {Number} [weight=1] Integer weight of the subcondition.
   */
  addSubcondition (subcondition, weight) {
    if (typeof subcondition === 'string') {
      subcondition = Condition.fromUri(subcondition)
    } else if (!(subcondition instanceof Condition)) {
      throw new Error('Subconditions must be URIs or objects of type Condition')
    }

    if (typeof weight === 'undefined') {
      weight = 1
    } else if (!isInteger(weight) || weight < 1) {
      throw new TypeError('Invalid weight, not an integer: ' + weight)
    }

    this.subconditions.push({
      type: CONDITION,
      body: subcondition,
      weight: weight
    })
  }

  /**
   * Add a fulfilled subcondition.
   *
   * When constructing a threshold fulfillment, this method allows you to
   * provide a fulfillment for one of the subconditions.
   *
   * Note that you do **not** have to add the subcondition if you're adding the
   * fulfillment. The condition can be calculated from the fulfillment and will
   * be added automatically.
   *
   * @param {Fulfillment|String} subfulfillment Fulfillment object or URI string
   *   representing a new subfulfillment to be added.
   * @param {Number} [weight=1] Integer weight of the subcondition.
   */
  addSubfulfillment (subfulfillment, weight) {
    if (typeof subfulfillment === 'string') {
      subfulfillment = Fulfillment.fromUri(subfulfillment)
    } else if (!(subfulfillment instanceof Fulfillment)) {
      throw new Error('Subfulfillments must be URIs or objects of type Fulfillment')
    }

    if (typeof weight === 'undefined') {
      weight = 1
    } else if (!isInteger(weight)) {
      throw new Error('Invalid weight, not an integer: ' + weight)
    }

    this.subconditions.push({
      type: FULFILLMENT,
      body: subfulfillment,
      weight: weight
    })
  }

  /**
   * Set the threshold.
   *
   * Determines the weighted threshold that is used to consider this condition
   * fulfilled. If the added weight of all valid subfulfillments is greater or
   * equal to this number, the threshold condition is considered to be
   * fulfilled.
   *
   * @param {Number} threshold Integer threshold
   */
  setThreshold (threshold) {
    if (!isInteger(threshold) || threshold < 1) {
      throw new TypeError('Threshold must be a integer greater than zero, was: ' +
        threshold)
    }

    this.threshold = threshold
  }

  /**
   * Get full bitmask.
   *
   * This is a type of condition that can contain subconditions. A complete
   * bitmask must contain the set of types that must be supported in order to
   * validate this fulfillment. Therefore, we need to calculate the bitwise OR
   * of this condition's FEATURE_BITMASK and all subcondition's and
   * subfulfillment's bitmasks.
   *
   * @return {Number} Complete bitmask for this fulfillment.
   */
  getBitmask () {
    let bitmask = super.getBitmask()

    for (let cond of this.subconditions) {
      bitmask |= cond.body.getBitmask()
    }

    return bitmask
  }

  /**
   * Produce the contents of the condition hash.
   *
   * This function is called internally by the `getCondition` method.
   *
   * @param {Hasher} hasher Hash generator
   *
   * @private
   */
  writeHashPayload (hasher) {
    if (!this.subconditions.length) {
      throw new MissingDataError('Requires subconditions')
    }

    const subconditions = this.subconditions
      // Serialize each subcondition with weight
      .map((c) => {
        const writer = new Writer()
        writer.writeVarUInt(c.weight)
        writer.write(
          c.type === FULFILLMENT
            ? c.body.getConditionBinary()
            : c.body.serializeBinary()
        )
        return writer.getBuffer()
      })

    // Canonically sort all conditions, first by length, then lexicographically
    const sortedSubconditions = this.constructor.sortBuffers(subconditions)

    hasher.writeUInt32(this.threshold)
    hasher.writeVarUInt(sortedSubconditions.length)
    sortedSubconditions.forEach((c) => hasher.write(c))
  }

  /**
   * Calculates the longest possible fulfillment length.
   *
   * In a threshold condition, the maximum length of the fulfillment depends on
   * the maximum lengths of the fulfillments of the subconditions. However,
   * usually not all subconditions must be fulfilled in order to meet the
   * threshold.
   *
   * Consequently, this method relies on an algorithm to determine which
   * combination of fulfillments, where no fulfillment can be left out, results
   * in the largest total fulfillment size.
   *
   * @return {Number} Maximum length of the fulfillment payload
   *
   * @private
   */
  calculateMaxFulfillmentLength () {
    // Calculate length of longest fulfillments
    let totalConditionLength = 0
    const subconditions = this.subconditions
      .map((cond) => {
        const conditionLength = this.constructor.predictSubconditionLength(cond)
        const fulfillmentLength = this.constructor.predictSubfulfillmentLength(cond)

        totalConditionLength += conditionLength

        return {
          weight: cond.weight,
          size: fulfillmentLength - conditionLength
        }
      })
      .sort((a, b) => b.weight - a.weight)

    const worstCaseFulfillmentsLength =
      totalConditionLength +
      this.constructor.calculateWorstCaseLength(
        this.threshold,
        subconditions
      )

    if (worstCaseFulfillmentsLength === -Infinity) {
      throw new MissingDataError('Insufficient subconditions/weights to meet the threshold')
    }

    // Calculate resulting total maximum fulfillment size
    const predictor = new Predictor()
    predictor.writeUInt32(this.threshold)              // threshold
    predictor.writeVarUInt(this.subconditions.length)  // count
    this.subconditions.forEach((cond) => {
      predictor.writeUInt8()                 // presence bitmask
      if (cond.weight !== 1) {
        predictor.writeUInt32(cond.weight)   // weight
      }
    })
    // Represents the sum of CONDITION/FULFILLMENT values
    predictor.skip(worstCaseFulfillmentsLength)

    return predictor.getSize()
  }

  static predictSubconditionLength (cond) {
    return cond.type === FULFILLMENT
      ? cond.body.getConditionBinary().length
      : cond.body.serializeBinary().length
  }

  static predictSubfulfillmentLength (cond) {
    const fulfillmentLength = cond.type === FULFILLMENT
      ? cond.body.getCondition().getMaxFulfillmentLength()
      : cond.body.getMaxFulfillmentLength()

    const predictor = new Predictor()
    predictor.writeUInt16()                                      // type
    predictor.writeVarOctetString({ length: fulfillmentLength }) // payload

    return predictor.getSize()
  }

  /**
   * Calculate the worst case length of a set of conditions.
   *
   * This implements a recursive algorithm to determine the longest possible
   * length for a valid, minimal (no fulfillment can be removed) set of
   * subconditions.
   *
   * Note that the input array of subconditions must be sorted by weight
   * descending.
   *
   * The algorithm works by recursively adding and not adding each subcondition.
   * Finally, it determines the maximum of all valid solutions.
   *
   * @author Evan Schwartz <evan@ripple.com>
   *
   * @param {Number} threshold Threshold that the remaining subconditions have
   *   to meet.
   * @param {Object[]} subconditions Set of subconditions.
   * @param {Number} subconditions[].weight Weight of the subcondition
   * @param {Number} subconditions[].size Maximum number of bytes added to the
   *   size if the fulfillment is included.
   * @param {Number} subconditions[].omitSize Maximum number of bytes added to
   *   the size if the fulfillment is omitted (and the condition is added
   *   instead.)
   * @param {Number} [size=0] Size the fulfillment already has (used by the
   *   recursive calls.)
   * @param {Number} [index=0] Current index in the subconditions array (used by
   *   the recursive calls.)
   * @return {Number} Maximum size of a valid, minimal set of fulfillments or
   *   -Infinity if there is no valid set.
   *
   * @private
   */
  static calculateWorstCaseLength (threshold, subconditions, index) {
    index = index || 0

    if (threshold <= 0) {
      return 0
    } else if (index < subconditions.length) {
      const nextCondition = subconditions[index]

      return Math.max(
        nextCondition.size + this.calculateWorstCaseLength(
          threshold - nextCondition.weight,
          subconditions,
          index + 1
        ),
        this.calculateWorstCaseLength(
          threshold,
          subconditions,
          index + 1
        )
      )
    } else {
      return -Infinity
    }
  }

  /**
   * Parse a fulfillment payload.
   *
   * Read a fulfillment payload from a Reader and populate this object with that
   * fulfillment.
   *
   * @param {Reader} reader Source to read the fulfillment payload from.
   *
   * @private
   */
  parsePayload (reader) {
    this.setThreshold(reader.readVarUInt())

    const conditionCount = reader.readVarUInt()
    for (let i = 0; i < conditionCount; i++) {
      const weight = reader.readVarUInt()
      const fulfillment = reader.readVarOctetString()
      const condition = reader.readVarOctetString()

      if (fulfillment.length && condition.length) {
        throw new ParseError('Subconditions may not provide both subcondition and fulfillment.')
      } else if (fulfillment.length) {
        this.addSubfulfillment(Fulfillment.fromBinary(fulfillment), weight)
      } else if (condition.length) {
        this.addSubcondition(Condition.fromBinary(condition), weight)
      } else {
        throw new ParseError('Subconditions must provide either subcondition or fulfillment.')
      }
    }
  }

  /**
   * Generate the fulfillment payload.
   *
   * This writes the fulfillment payload to a Writer.
   *
   * @param {Writer} writer Subject for writing the fulfillment payload.
   *
   * @private
   */
  writePayload (writer) {
    const subfulfillments = this.subconditions
      .map((x, i) => (
        x.type === FULFILLMENT
        ? Object.assign({}, x, {
          index: i,
          size: x.body.serializeBinary().length,
          omitSize: x.body.getConditionBinary().length
        })
        : null))
      .filter(Boolean)

    const smallestSet = this.constructor.calculateSmallestValidFulfillmentSet(
      this.threshold,
      subfulfillments
    ).set

    const optimizedSubfulfillments =
      // Take minimum set of fulfillments and turn rest into conditions
      this.subconditions.map((c, i) => {
        if (c.type === FULFILLMENT && smallestSet.indexOf(i) === -1) {
          return Object.assign({}, c, {
            type: CONDITION,
            body: c.body.getCondition()
          })
        } else {
          return c
        }
      })

    const serializedSubconditions = optimizedSubfulfillments
      .map((cond) => {
        const writer = new Writer()
        writer.writeVarUInt(cond.weight)
        writer.writeVarOctetString(cond.type === FULFILLMENT ? cond.body.serializeBinary() : EMPTY_BUFFER)
        writer.writeVarOctetString(cond.type === CONDITION ? cond.body.serializeBinary() : EMPTY_BUFFER)
        return writer.getBuffer()
      })

    const sortedSubconditions = this.constructor.sortBuffers(serializedSubconditions)

    writer.writeVarUInt(this.threshold)
    writer.writeVarUInt(sortedSubconditions.length)
    sortedSubconditions.forEach(writer.write.bind(writer))
  }

  /**
   * Select the smallest valid set of fulfillments.
   *
   * From a set of fulfillments, selects the smallest combination of
   * fulfillments which meets the given threshold.
   *
   * @param {Number} threshold (Remaining) threshold that must be met.
   * @param {Object[]} fulfillments Set of fulfillments
   * @param {Object} [state] Used for recursion
   * @param {Number} state.index Current index being processed.
   * @param {Number} state.size Size of the binary so far
   * @param {Object[]} state.set Set of fulfillments that were included.
   * @return {Object} Result with size and set properties.
   *
   * @private
   */
  static calculateSmallestValidFulfillmentSet (threshold, fulfillments, state) {
    state = state || {
      index: 0,
      size: 0,
      set: []
    }

    if (threshold <= 0) {
      return {
        size: state.size,
        set: state.set
      }
    } else if (state.index < fulfillments.length) {
      const nextFulfillment = fulfillments[state.index]

      const withNext = this.calculateSmallestValidFulfillmentSet(
        threshold - nextFulfillment.weight,
        fulfillments,
        {
          size: state.size + nextFulfillment.size,
          index: state.index + 1,
          set: state.set.concat(nextFulfillment.index)
        }
      )

      const withoutNext = this.calculateSmallestValidFulfillmentSet(
        threshold,
        fulfillments,
        {
          size: state.size + nextFulfillment.omitSize,
          index: state.index + 1,
          set: state.set
        }
      )

      return withNext.size < withoutNext.size
        ? withNext
        : withoutNext
    } else {
      return {
        size: Infinity
      }
    }
  }

  /**
   * Sort buffers according to spec.
   *
   * Buffers must be sorted first by length. Buffers with the same length are
   * sorted lexicographically.
   *
   * @param {Buffer[]} buffers Set of octet strings to sort.
   * @return {Buffer[]} Sorted buffers.
   *
   * @private
   */
  static sortBuffers (buffers) {
    return buffers.slice().sort((a, b) => (
      a.length !== b.length
      ? a.length - b.length
      : Buffer.compare(a, b)
    ))
  }

  /**
   * Check whether this fulfillment meets all validation criteria.
   *
   * This will validate the subfulfillments and verify that there are enough
   * subfulfillments to meet the threshold.
   *
   * @param {Buffer} message Message to validate against.
   * @return {Boolean} Whether this fulfillment is valid.
   */
  validate (message) {
    const fulfillments = this.subconditions.filter((cond) => cond.type === FULFILLMENT)

    // Find total weight and smallest individual weight
    let minWeight = Infinity
    const totalWeight = fulfillments.reduce((total, cond) => {
      minWeight = Math.min(minWeight, cond.weight)
      return total + cond.weight
    }, 0)

    // Total weight must meet the threshold
    if (totalWeight < this.threshold) {
      throw new Error('Threshold not met')
    }

    // But the set must be minimal, there mustn't be any fulfillments
    // we could take out
    if (this.threshold + minWeight <= totalWeight) {
      throw new Error('Fulfillment is not minimal')
    }

    // Ensure all subfulfillments are valid
    return fulfillments.every((f) => f.body.validate(message))
  }
}

ThresholdSha256.TYPE_ID = 2
ThresholdSha256.FEATURE_BITMASK = 0x09

// DEPRECATED
ThresholdSha256.prototype.addSubconditionUri =
  ThresholdSha256.prototype.addSubcondition
ThresholdSha256.prototype.addSubfulfillmentUri =
  ThresholdSha256.prototype.addSubfulfillment

module.exports = ThresholdSha256
