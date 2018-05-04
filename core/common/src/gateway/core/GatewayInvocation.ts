/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
/** @module Gateway */

import { IModelError } from "../../IModelError";
import { BentleyStatus } from "@bentley/bentleyjs-core";
import { Logger } from "@bentley/bentleyjs-core";
import { Gateway } from "../../Gateway";
import { GatewayOperation } from "./GatewayOperation";
import { GatewayRegistry, CURRENT_INVOCATION } from "./GatewayRegistry";
import { GatewayRequestStatus } from "./GatewayRequest";
import { GatewayProtocol, GatewayProtocolEvent, SerializedGatewayRequest, GatewayRequestFulfillment } from "./GatewayProtocol";
import { GatewayMarshaling } from "./GatewayMarshaling";
import { GatewayPendingResponse } from "./GatewayControl";

/** A gateway operation invocation in response to a request. */
export class GatewayInvocation {
  private _threw: boolean;
  private _pending: boolean = false;

  /** The protocol for this invocation. */
  public readonly protocol: GatewayProtocol;

  /** The received request. */
  public readonly request: SerializedGatewayRequest;

  /** The operation of the request. */
  public readonly operation: GatewayOperation;

  /** The implementation response. */
  public readonly result: Promise<any>;

  /** Whether an exception occured. */
  public get threw() { return this._threw; }

  /** The fulfillment for this request. */
  public readonly fulfillment: Promise<GatewayRequestFulfillment>;

  /** The status for this request. */
  public get status(): GatewayRequestStatus {
    if (this.threw) {
      return GatewayRequestStatus.Rejected;
    } else {
      if (this._pending)
        return GatewayRequestStatus.Pending;
      else
        return GatewayRequestStatus.Resolved;
    }
  }

  /**
   * The invocation for the current gateway operation.
   * @note The return value of this function is only reliable in a gateway member function where program control was received from the GatewayInvocation constructor function.
   */
  public static current(context: Gateway): GatewayInvocation {
    return (context as any)[CURRENT_INVOCATION];
  }

  /** Constructs an invocation. */
  public constructor(protocol: GatewayProtocol, request: SerializedGatewayRequest) {
    this.protocol = protocol;
    this.request = request;
    this.operation = GatewayOperation.lookup(request.operation.gateway, request.operation.name);
    protocol.events.raiseEvent(GatewayProtocolEvent.RequestReceived, this);

    try {
      this._threw = false;

      const parameters = GatewayMarshaling.deserialize(this.operation, protocol, request.parameters);
      const impl = GatewayRegistry.instance.getImplementationForGateway(this.operation.gateway);
      const op = this.lookupOperationFunction(impl);
      (impl as any)[CURRENT_INVOCATION] = this;
      this.result = op.call(impl, ...parameters);
    } catch (error) {
      this._threw = true;
      this.result = Promise.reject(error);
      protocol.events.raiseEvent(GatewayProtocolEvent.BackendErrorOccurred, this);
    }

    this.fulfillment = this.result.then((value) => {
      const result = GatewayMarshaling.serialize(this.operation, protocol, value);
      const status = protocol.getCode(this.status);
      protocol.events.raiseEvent(GatewayProtocolEvent.BackendResponseCreated, this);
      return this.createFulfillment(result, status);
    }, (reason) => {
      if (reason instanceof GatewayPendingResponse) {
        this._pending = true;
        protocol.events.raiseEvent(GatewayProtocolEvent.BackendReportedPending, this);
        return this.createFulfillment(reason.message, protocol.getCode(this.status));
      }

      this._threw = true;
      const result = GatewayMarshaling.serialize(this.operation, protocol, reason);
      const status = protocol.getCode(this.status);
      protocol.events.raiseEvent(GatewayProtocolEvent.BackendErrorOccurred, this);
      return this.createFulfillment(result, status);
    });
  }

  private createFulfillment(result: string, status: number): GatewayRequestFulfillment {
    return { result, status, id: this.request.id, gateway: this.operation.gateway.name };
  }

  private lookupOperationFunction(implementation: Gateway): (...args: any[]) => any {
    const func = (implementation as any)[this.operation.name];
    if (!func || typeof (func) !== "function") {
      throw new IModelError(BentleyStatus.ERROR, `Gateway class "${implementation.constructor.name}" does not implement operation "${this.operation.name}".`, Logger.logError, "imodeljs-backend.Gateway");
    }

    return func;
  }
}
