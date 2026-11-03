package native

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount"

type admission struct {
	client     *http.Client
	url        string
	pvcURL     string
	uid        string
	mode       string
	generation int64
	tokenFile  string

	// boundClaim belongs only to an already admitted endpoint process.
	boundClaim string
}

func newAdmission(mode string) (*admission, error) {
	name, namespace, uid := os.Getenv("APPLICATION_NAME"), os.Getenv("POD_NAMESPACE"), os.Getenv("APPLICATION_UID")
	if name == "" || namespace == "" || uid == "" {
		return nil, errors.New("missing application admission identity")
	}
	generation, err := strconv.ParseInt(os.Getenv("APPLICATION_GENERATION"), 10, 64)
	if err != nil || generation < 1 {
		return nil, errors.New("missing application execution generation")
	}
	ca, err := os.ReadFile(serviceAccountDirectory + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid Kubernetes CA")
	}
	return &admission{client: &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}, url: "https://kubernetes.default.svc/apis/restic.bartl.sh/v1alpha1/namespaces/" + url.PathEscape(namespace) + "/resticapplications/" + url.PathEscape(name), pvcURL: "https://kubernetes.default.svc/api/v1/namespaces/" + url.PathEscape(namespace) + "/persistentvolumeclaims/", uid: uid, mode: mode, generation: generation, tokenFile: serviceAccountDirectory + "/token"}, nil
}

var errAdmissionRevoked = errors.New("admission revoked")

func revoked(reason string) error {
	return fmt.Errorf("%w: %s", errAdmissionRevoked, reason)
}

// read distinguishes an authoritative Kubernetes absence from a proxy or API outage.
func (a *admission) read(ctx context.Context, endpoint, token string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			var status struct {
				Kind       string `json:"kind"`
				APIVersion string `json:"apiVersion"`
				Reason     string `json:"reason"`
				Code       int    `json:"code"`
			}
			if decodeObservation(resp.Body, &status) == nil && status.Kind == "Status" && status.APIVersion == "v1" && status.Reason == "NotFound" && status.Code == http.StatusNotFound {
				return revoked("Kubernetes object no longer exists")
			}
		}
		return fmt.Errorf("admission observation unavailable: HTTP %d", resp.StatusCode)
	}
	return decodeObservation(resp.Body, target)
}

func decodeObservation(body io.Reader, target any) error {
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	// Read through EOF so a truncated body or trailing malformed data is unknown.
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		if err != nil {
			return err
		}
		return errors.New("admission observation contains multiple JSON values")
	}
	return nil
}

func (a *admission) checkApplication(ctx context.Context, token string) (string, error) {
	var app struct {
		Metadata struct {
			UID               string  `json:"uid"`
			Generation        int64   `json:"generation"`
			DeletionTimestamp *string `json:"deletionTimestamp"`
		} `json:"metadata"`
		Spec struct {
			Replicas      *int   `json:"replicas"`
			ExistingClaim string `json:"existingClaim"`
		} `json:"spec"`
		Status struct {
			State              string `json:"state"`
			ObservedGeneration int64  `json:"observedGeneration"`
			Operation          *struct {
				Result     string `json:"result"`
				JobUID     string `json:"jobUID"`
				PVCUID     string `json:"pvcUID"`
				Generation int64  `json:"generation"`
			} `json:"operation"`
		} `json:"status"`
	}
	if err := a.read(ctx, a.url, token, &app); err != nil {
		return "", err
	}
	if app.Metadata.UID == "" || app.Metadata.Generation < 1 {
		return "", errors.New("application observation lacks identity")
	}
	if app.Metadata.UID != a.uid || app.Metadata.DeletionTimestamp != nil {
		return "", revoked("current application identity refuses work")
	}
	if app.Spec.Replicas == nil {
		return "", errors.New("application observation lacks running intent")
	}
	if *app.Spec.Replicas != 1 {
		return "", revoked("current application intent refuses work")
	}
	if a.mode == "replicate" {
		op := app.Status.Operation
		if app.Metadata.Generation != a.generation || app.Status.State != "Ready" || app.Status.ObservedGeneration != app.Metadata.Generation {
			return "", revoked("replication requires its admitted generation to be current and Ready")
		}
		if op == nil || op.Result != "Succeeded" || op.PVCUID != os.Getenv("PVC_UID") {
			return "", revoked("replication no longer owns the verified target")
		}
	}
	if a.mode == "serve" {
		op := app.Status.Operation
		if op == nil || op.Result != "Succeeded" || op.PVCUID != os.Getenv("PVC_UID") {
			return "", revoked("serving no longer owns the verified target")
		}
	}
	if a.mode == "lifecycle" {
		op := app.Status.Operation
		if op == nil || op.Result != "Running" || op.JobUID != os.Getenv("OPERATION_UID") || op.PVCUID != os.Getenv("PVC_UID") || op.Generation != app.Metadata.Generation {
			return "", revoked("lifecycle operation no longer owns current application and target")
		}
	}
	if app.Spec.ExistingClaim == "" || os.Getenv("PVC_UID") == "" {
		return "", errors.New("missing live PVC execution identity")
	}
	if a.boundClaim != "" && app.Spec.ExistingClaim != a.boundClaim {
		return "", revoked("serving application no longer names its admitted claim")
	}
	return app.Spec.ExistingClaim, nil
}

func (a *admission) checkPVC(ctx context.Context, token, claim string) error {
	var pvc struct {
		Metadata struct {
			UID               string            `json:"uid"`
			Annotations       map[string]string `json:"annotations"`
			DeletionTimestamp *string           `json:"deletionTimestamp"`
		} `json:"metadata"`
	}
	if err := a.read(ctx, a.pvcURL+url.PathEscape(claim), token, &pvc); err != nil {
		return err
	}
	if pvc.Metadata.UID == "" {
		return errors.New("PVC observation lacks identity")
	}
	if pvc.Metadata.UID != os.Getenv("PVC_UID") || pvc.Metadata.Annotations["restic.bartl.sh/application-uid"] != a.uid || pvc.Metadata.DeletionTimestamp != nil {
		return revoked("current PVC ownership refuses work")
	}
	return nil
}

func (a *admission) observe(ctx context.Context) (string, error) {
	token, err := os.ReadFile(a.tokenFile)
	if err != nil {
		return "", err
	}
	claim, appErr := a.checkApplication(ctx, string(token))
	if errors.Is(appErr, errAdmissionRevoked) {
		return "", appErr
	}
	if a.boundClaim != "" {
		claim = a.boundClaim
	}
	if claim == "" {
		return "", appErr
	}
	pvcErr := a.checkPVC(ctx, string(token), claim)
	if errors.Is(pvcErr, errAdmissionRevoked) {
		return "", pvcErr
	}
	if appErr != nil {
		return "", appErr
	}
	return claim, pvcErr
}

func (a *admission) check(ctx context.Context) error {
	_, err := a.observe(ctx)
	return err
}
func (a *admission) monitor(ctx context.Context, cancel context.CancelCauseFunc) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer a.client.CloseIdleConnections()
	unavailable := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			err := a.check(ctx)
			if a.mode == "serve" && err != nil && !errors.Is(err, errAdmissionRevoked) {
				if !unavailable {
					log.Printf("endpoint admission observation unavailable; retaining admitted process: %v", err)
					unavailable = true
				}
				continue
			}
			if err != nil {
				cancel(err)
				return
			}
			if unavailable {
				log.Print("endpoint admission observation verified again")
				unavailable = false
			}
		}
	}
}
